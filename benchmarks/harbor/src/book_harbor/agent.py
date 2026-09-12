"""Harbor installed-agent adapter for the Book CLI.

Harbor is the harness behind Terminal-Bench, which is one of the three
components of the Artificial Analysis Coding Agent Index. This adapter
installs Book into the task container and drives it in print mode
(``book -p ... --output-format stream-json``), then converts Book's
stream-JSON transcript into an ATIF trajectory so Harbor can report
cost, tokens, and per-step tool use.

Run it with::

    harbor run -d terminal-bench/terminal-bench \
      -a book_harbor:BookAgent -m anthropic/claude-opus-5 -k 3
"""

from __future__ import annotations

import json
import shlex
from datetime import datetime, timezone
from typing import Annotated, Any, override

from pydantic import Field

from harbor.agents.capabilities import AgentCapabilities
from harbor.agents.installed.base import (
    BaseInstalledAgent,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.agents.options import Cli, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json

#: npm package that publishes the `book` binary.
DEFAULT_PACKAGE = "@letrquan/book"

#: Book needs Node 22.13+; distro packages are routinely older, so glibc
#: images get Node from nvm and only musl images fall back to the packaged one.
NODE_MAJOR = 22


class BookOptions(InstalledAgentOptions):
    """``--ak key=value`` options accepted by :class:`BookAgent`."""

    effort: Annotated[str | None, Cli("--effort")] = Field(
        default=None,
        description="Thinking effort: low | medium | high | xhigh | max.",
    )
    max_turns: Annotated[int | None, Cli("--max-turns")] = Field(
        default=None,
        description="Cap on agent turns. Omit for Book's own default.",
    )
    permission_mode: Annotated[str | None, Cli("--permission-mode")] = Field(
        default="bypassPermissions",
        description=(
            "Book permission mode. Benchmarks run unattended, so the default "
            "bypasses prompts; nothing else can answer them."
        ),
    )
    package: str = Field(
        default=DEFAULT_PACKAGE,
        description="npm package to install. Point at a tarball URL or path to test a build.",
    )
    provider: str | None = Field(
        default=None,
        description=(
            "Force BOOK_PROVIDER (anthropic | openai | auto). Inferred from the "
            "model's provider prefix when unset."
        ),
    )


class BookAgent(BaseInstalledAgent):
    """Runs Book in print mode against a Harbor task.

    Book's stream-JSON transcript (captured to ``book.jsonl``) carries every
    event the run produced. The terminal ``result`` event carries
    ``accounting.inclusiveUsage`` / ``accounting.inclusiveCostUsd`` — the
    totals *including* delegated managed-agent work, which is the number a
    benchmark must report.
    """

    capabilities = AgentCapabilities(atif=True)

    # Book reads its own BOOK_* env vars; passthrough keeps the provider-native
    # names (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) available too, so a user
    # who exported only those still gets a working run.
    MODEL_CONNECTION = ModelConnectionSpec(
        api_key_envs=("BOOK_API_KEY",),
        base_url_envs=("BOOK_BASE_URL",),
        passthrough=True,
    )

    options_model = BookOptions

    _OUTPUT_FILENAME = "book.jsonl"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._events: list[dict[str, Any]] | None = None

    @staticmethod
    @override
    def name() -> str:
        return "book"

    @property
    def _options(self) -> BookOptions:
        options = self.options
        assert isinstance(options, BookOptions)
        return options

    @override
    def get_version_command(self) -> str | None:
        # ~/.nvm is absent on musl images, where Node comes from apk instead.
        return "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; book --version"

    # ------------------------------------------------------------------
    # install
    # ------------------------------------------------------------------

    def _install_spec(self) -> str:
        """The argument handed to ``npm i -g``."""
        package = self._options.package
        # A tarball or path pins itself; only a bare package name takes a version.
        if "/" in package and not package.startswith("@"):
            return shlex.quote(package)
        if package.endswith(".tgz"):
            return shlex.quote(package)
        version_spec = f"@{self._version}" if self._version else "@latest"
        return shlex.quote(f"{package}{version_spec}")

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        # `nodejs`/`npm` cover musl images, where nvm cannot be used; `coreutils`
        # provides the `stdbuf` that run() pipes through, which busybox lacks;
        # `git` is what Book's session-state block shells out to.
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "coreutils", "git", "nodejs", "npm")
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -euo pipefail; "
                # nvm ships glibc binaries and its source-build fallback fails
                # inside task images, so musl uses the packaged Node instead.
                "if ldd --version 2>&1 | grep -qi musl || "
                "[ -f /etc/alpine-release ]; then "
                "node --version && npm --version; "
                f"else {nvm_node_install_snippet(NODE_MAJOR)}; fi && "
                f"npm i -g {self._install_spec()} && "
                "book --version"
            ),
        )

    # ------------------------------------------------------------------
    # run
    # ------------------------------------------------------------------

    def _book_model(self) -> str:
        """Book takes a bare model id; Harbor names models ``provider/id``."""
        if not self.model_name:
            raise ValueError("A model is required: pass -m provider/model-id")
        _, _, model_id = self.model_name.partition("/")
        return model_id or self.model_name

    def _book_provider(self) -> str:
        if self._options.provider:
            return self._options.provider
        provider = (self.model_connection.provider or "").lower()
        if provider == "anthropic":
            return "anthropic"
        # Everything else Book can reach is an OpenAI-compatible endpoint.
        return "openai" if provider else "auto"

    def _run_env(self) -> dict[str, str]:
        connection = self.model_connection
        env = dict(connection.env)

        if not env.get("BOOK_API_KEY"):
            if not connection.api_key:
                raise ValueError(
                    "No API key resolved for model "
                    f"{self.model_name!r}. Export BOOK_API_KEY or the provider's "
                    "own key env var (e.g. ANTHROPIC_API_KEY)."
                )
            env["BOOK_API_KEY"] = connection.api_key

        if not env.get("BOOK_BASE_URL") and connection.base_url:
            # Book normalizes a trailing /v1 itself, so Harbor's provider
            # default can be passed through unchanged.
            env["BOOK_BASE_URL"] = connection.base_url

        env["BOOK_MODEL"] = self._book_model()
        env["BOOK_PROVIDER"] = self._book_provider()
        # Keep Book's user-global state inside the captured logs directory so a
        # failed trial can be inspected from the job artifacts.
        env["BOOK_HOME"] = f"{self.environment_logs_dir}/book-home"
        return env

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        env = self._run_env()
        output_path = f"{self.environment_logs_dir}/{self._OUTPUT_FILENAME}"

        cli_flags = self.build_cli_flags()
        cli_flags_arg = f"{cli_flags} " if cli_flags else ""

        await self.exec_as_agent(
            environment,
            command=(
                "[ -f ~/.nvm/nvm.sh ] && . ~/.nvm/nvm.sh; "
                f"mkdir -p {shlex.quote(str(self.environment_logs_dir))} && "
                f"book --output-format stream-json {cli_flags_arg}"
                f"-p {shlex.quote(instruction)} "
                f"2>&1 </dev/null | stdbuf -oL tee {shlex.quote(output_path)}"
            ),
            env=env,
        )

        if messages := self._error_messages():
            raise NonZeroAgentExitCodeError(
                "Book emitted error event(s): " + "; ".join(messages[:3])
            )

    # ------------------------------------------------------------------
    # trajectory
    # ------------------------------------------------------------------

    def _parse_stdout(self) -> list[dict[str, Any]]:
        """Read Book's stream-JSON lines, skipping interleaved stderr text.

        Cached: the transcript is read once per run and every reader below
        (errors, session id, result payload) works off the same list.
        """
        if self._events is not None:
            return self._events

        output_path = self.logs_dir / self._OUTPUT_FILENAME
        if not output_path.exists():
            return []

        events: list[dict[str, Any]] = []
        for line in output_path.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict) and isinstance(parsed.get("type"), str):
                events.append(parsed)

        self._events = events
        return events

    def _error_messages(self) -> list[str]:
        return [
            str(event.get("error"))
            for event in self._parse_stdout()
            if event.get("type") == "error" and event.get("error")
        ]

    def _result_payload(self) -> dict[str, Any] | None:
        """Book's terminal ``result`` event payload, or None if the run died first."""
        for event in reversed(self._parse_stdout()):
            if event.get("type") == "result":
                payload = event.get("result")
                if isinstance(payload, dict):
                    return payload
        return None

    @staticmethod
    def _final_metrics(result: dict[str, Any], total_steps: int) -> FinalMetrics | None:
        """Build ATIF totals from Book's accounting block.

        ``accounting.inclusiveUsage`` counts what delegated managed agents and
        subagents spent; the top-level ``usage`` does not, and that is most of
        the money in a run that delegates. Cost stays ``None`` when Book could
        not price the model, so Harbor excludes it rather than reporting zero.
        """
        accounting = result.get("accounting")
        accounting = accounting if isinstance(accounting, dict) else {}
        usage = accounting.get("inclusiveUsage") or accounting.get("directUsage")
        if not isinstance(usage, dict):
            usage = result.get("usage")
        if not isinstance(usage, dict):
            return None

        cost = accounting.get("inclusiveCostUsd")
        if cost is None:
            cost = accounting.get("costUsd")
        cost = float(cost) if isinstance(cost, (int, float)) else None

        return FinalMetrics(
            # Book's promptTokens already includes cache reads, matching ATIF.
            total_prompt_tokens=int(usage.get("promptTokens") or 0) or None,
            total_completion_tokens=int(usage.get("completionTokens") or 0) or None,
            total_cached_tokens=int(usage.get("cacheReadInputTokens") or 0) or None,
            total_cost_usd=cost,
            total_steps=total_steps,
        )

    @staticmethod
    def _iso(timestamp_ms: Any) -> str | None:
        if not isinstance(timestamp_ms, (int, float)):
            return None
        try:
            return datetime.fromtimestamp(timestamp_ms / 1000, tz=timezone.utc).isoformat()
        except (OSError, ValueError, OverflowError):
            return None

    def _step_from_message(self, index: int, message: dict[str, Any]) -> Step:
        role = message.get("role")
        step_kwargs: dict[str, Any] = {
            "step_id": index,
            "timestamp": self._iso(message.get("timestamp")),
            "source": "user" if role == "user" else "agent",
            "message": str(message.get("content") or ""),
        }
        if role != "user":
            step_kwargs["model_name"] = self.model_name
            step_kwargs["llm_call_count"] = 1

        if reasoning := message.get("reasoningContent"):
            step_kwargs["reasoning_content"] = str(reasoning)

        calls = message.get("toolCalls")
        if isinstance(calls, list) and calls:
            step_kwargs["tool_calls"] = [
                ToolCall(
                    tool_call_id=str(call.get("id") or ""),
                    function_name=str(call.get("name") or ""),
                    arguments=call.get("arguments")
                    if isinstance(call.get("arguments"), dict)
                    else {},
                )
                for call in calls
                if isinstance(call, dict)
            ]

        results = message.get("toolResults")
        if isinstance(results, list) and results:
            step_kwargs["observation"] = Observation(
                results=[
                    ObservationResult(
                        source_call_id=str(result.get("toolCallId") or "") or None,
                        content=str(result.get("content") or ""),
                    )
                    for result in results
                    if isinstance(result, dict)
                ]
            )

        return Step(**step_kwargs)

    def _build_trajectory(self) -> Trajectory | None:
        """Convert Book's run into an ATIF trajectory.

        The steps come from the ``result`` event's message history rather than
        from the streamed events: streaming emits an assistant turn only once
        its tools have run, so the wire order puts a turn's tool calls ahead of
        its own text. The history is already ordered and complete.
        """
        result = self._result_payload()
        if result is None:
            return None

        messages = result.get("messages")
        if not isinstance(messages, list):
            return None

        steps: list[Step] = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            # `local` messages are slash-command renderings for the TUI; they
            # were never part of the conversation the model saw.
            if message.get("kind") == "local":
                continue
            steps.append(self._step_from_message(len(steps) + 1, message))

        if not steps:
            return None

        session_id = next(
            (
                str(event.get("session_id"))
                for event in self._parse_stdout()
                if event.get("type") == "session" and event.get("session_id")
            ),
            None,
        )

        return Trajectory(
            schema_version="ATIF-v1.7",
            session_id=session_id or "unknown",
            agent=Agent(
                name=self.name(),
                version=self.version() or "unknown",
                model_name=self.model_name,
            ),
            steps=steps,
            final_metrics=self._final_metrics(result, len(steps)),
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        try:
            trajectory = self._build_trajectory()
        except Exception:
            self.logger.exception("Failed to convert the Book run to a trajectory")
            return
        if not trajectory:
            return

        trajectory_path = self.logs_dir / "trajectory.json"
        try:
            trajectory_path.write_text(
                format_trajectory_json(trajectory.to_json_dict())
            )
        except OSError as exc:
            self.logger.debug(f"Failed to write {trajectory_path}: {exc}")

        if metrics := trajectory.final_metrics:
            context.cost_usd = metrics.total_cost_usd
            context.n_input_tokens = metrics.total_prompt_tokens or 0
            context.n_output_tokens = metrics.total_completion_tokens or 0
            context.n_cache_tokens = metrics.total_cached_tokens or 0

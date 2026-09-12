"""Adapter tests that need neither Docker nor a model credential."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from harbor.models.agent.context import AgentContext

from book_harbor import BookAgent


def make_agent(tmp_path, monkeypatch, model="anthropic/claude-opus-5", **kwargs):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("BOOK_API_KEY", raising=False)
    monkeypatch.delenv("BOOK_BASE_URL", raising=False)
    agent = BookAgent(logs_dir=tmp_path, **kwargs)
    agent.model_name = model
    return agent


def test_name_and_defaults(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    assert BookAgent.name() == "book"
    # Nothing can answer a permission prompt in an unattended trial.
    assert "--permission-mode bypassPermissions" in agent.build_cli_flags()


def test_options_render_as_cli_flags(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch, effort="high", max_turns=40)
    flags = agent.build_cli_flags()
    assert "--effort high" in flags
    assert "--max-turns 40" in flags


def test_env_maps_harbor_model_onto_book(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    env = agent._run_env()
    assert env["BOOK_MODEL"] == "claude-opus-5"
    assert env["BOOK_PROVIDER"] == "anthropic"
    assert env["BOOK_API_KEY"] == "test-key"
    # Book strips a duplicate /v1, so Harbor's provider default passes through.
    assert env["BOOK_BASE_URL"].startswith("https://api.anthropic.com")
    assert env["BOOK_HOME"].endswith("/book-home")


def test_openai_compatible_provider_is_inferred(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    agent = make_agent(tmp_path, monkeypatch, model="openrouter/some-model")
    env = agent._run_env()
    assert env["BOOK_PROVIDER"] == "openai"
    assert env["BOOK_MODEL"] == "some-model"


def test_missing_credential_is_a_clear_error(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(ValueError, match="No API key resolved"):
        agent._run_env()


def test_install_spec_pins_a_published_version(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch, version="0.2.0")
    assert agent._install_spec() == "@letrquan/book@0.2.0"


def test_install_spec_accepts_a_local_tarball(tmp_path, monkeypatch):
    agent = make_agent(
        tmp_path, monkeypatch, package="/builds/letrquan-book-0.2.0.tgz", version="0.2.0"
    )
    # A tarball pins itself; appending a version would break the install.
    assert agent._install_spec() == "/builds/letrquan-book-0.2.0.tgz"


FIXTURE = Path(__file__).parent / "fixtures" / "mock-run.jsonl"

#: A minimal hand-written transcript. The real one is FIXTURE, captured from
#: `book -p ... --output-format stream-json` against the repo's mock provider.
TRANSCRIPT = [
    {"type": "session", "session_id": "sess-1"},
    {
        "type": "result",
        "stopReason": "normal_completion",
        "result": {
            "messages": [
                {"role": "user", "content": "Fix the failing test.", "timestamp": 1789241560000},
                {
                    "role": "assistant",
                    "content": "Listing the repo.",
                    "reasoningContent": "I should look first.",
                    "toolCalls": [
                        {"id": "call-1", "name": "Bash", "arguments": {"command": "ls"}}
                    ],
                    "toolResults": [
                        {"version": 2, "toolCallId": "call-1", "status": "success", "content": "app.py"}
                    ],
                },
                {"role": "assistant", "content": "/cost output", "kind": "local"},
                {"role": "assistant", "content": "Done."},
            ],
            "usage": {"promptTokens": 10, "completionTokens": 2, "totalTokens": 12},
            "accounting": {
                "inclusiveUsage": {
                    "promptTokens": 1000,
                    "completionTokens": 200,
                    "totalTokens": 1200,
                    "cacheReadInputTokens": 800,
                    "cacheCreationInputTokens": 50,
                },
                "inclusiveCostUsd": 0.42,
                "costUsd": 0.01,
            },
        },
    },
]


def write_transcript(agent, events):
    lines = ["Debug: not JSON at all", *[json.dumps(event) for event in events]]
    (agent.logs_dir / "book.jsonl").write_text("\n".join(lines) + "\n")


def test_trajectory_and_usage_from_transcript(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    write_transcript(agent, TRANSCRIPT)

    context = AgentContext()
    agent.populate_context_post_run(context)

    # Delegated spend counts: the top-level usage would report 10/2/0.01.
    assert context.cost_usd == 0.42
    assert context.n_input_tokens == 1000
    assert context.n_output_tokens == 200
    assert context.n_cache_tokens == 800

    trajectory = json.loads((tmp_path / "trajectory.json").read_text())
    assert trajectory["session_id"] == "sess-1"
    steps = trajectory["steps"]
    assert [step["step_id"] for step in steps] == list(range(1, len(steps) + 1))
    assert steps[0]["source"] == "user"
    assert steps[0]["message"] == "Fix the failing test."

    agent_steps = [step for step in steps if step["source"] == "agent"]
    # A turn keeps its own text, reasoning, call, and result in one step.
    assert agent_steps[0]["message"] == "Listing the repo."
    assert agent_steps[0]["reasoning_content"] == "I should look first."
    assert agent_steps[0]["tool_calls"][0]["function_name"] == "Bash"
    assert agent_steps[0]["observation"]["results"][0]["content"] == "app.py"
    assert agent_steps[-1]["message"] == "Done."
    # A `local` message is a TUI rendering the model never saw.
    assert "/cost output" not in json.dumps(trajectory)


def test_real_transcript_from_the_mock_provider(tmp_path, monkeypatch):
    """Parse a transcript Book actually produced, not a hand-written one."""
    agent = make_agent(tmp_path, monkeypatch, model="openai/mock-model")
    (agent.logs_dir / "book.jsonl").write_text(FIXTURE.read_text())

    context = AgentContext()
    agent.populate_context_post_run(context)

    # The mock cannot be priced, so cost stays absent rather than zero —
    # Harbor excludes missing telemetry instead of averaging a zero in.
    assert context.cost_usd is None
    assert context.n_input_tokens == 200
    assert context.n_output_tokens == 40

    steps = json.loads((tmp_path / "trajectory.json").read_text())["steps"]
    assert [step["source"] for step in steps] == ["user", "agent", "agent"]
    assert steps[0]["message"] == "create smoke.txt"
    # Streaming emits a turn's tool_use before its own text; the history does
    # not, so the Write call stays attached to the turn that made it.
    assert steps[1]["tool_calls"][0]["function_name"] == "Write"
    assert steps[1]["message"] == "I will create the file."
    assert steps[2]["message"] == "Wrote the file. DONE"


def test_error_events_are_surfaced(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    write_transcript(agent, [{"type": "error", "error": "rate limit exceeded"}])
    assert agent._error_messages() == ["rate limit exceeded"]


def test_no_transcript_leaves_context_untouched(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    context = AgentContext()
    agent.populate_context_post_run(context)
    assert context.is_empty()


def test_a_run_that_died_before_the_result_event_yields_no_trajectory(tmp_path, monkeypatch):
    agent = make_agent(tmp_path, monkeypatch)
    write_transcript(agent, [{"type": "session", "session_id": "sess-1"}])
    context = AgentContext()
    agent.populate_context_post_run(context)
    assert context.is_empty()
    assert not (tmp_path / "trajectory.json").exists()

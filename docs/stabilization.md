# Main Branch Stabilization Gate

Book requires a short run-based stabilization window before runtime attribution work advances.
The `Stabilization` workflow runs after every completed main-branch `CI` workflow and can also be
started manually.

The gate passes only when:

- the three most recent completed `CI` runs for `main` are successful;
- each counted run was triggered by a push or a manual CI dispatch, not a pull request; and
- no open issue has the `regression:lifecycle` or `regression:accounting` label.

Manual reruns against the same commit are allowed. Repeatability of the complete platform matrix is
the purpose of the window: Node.js 20 and 24 on Windows and Ubuntu, integration tests, package smoke,
audits, coverage, and UI performance budgets must all remain green.

## Regression Handling

Open a blocking issue and apply the appropriate label when a regression affects:

- session/run terminal state, cancellation, interruption, resume, lifecycle hooks, or cleanup:
  `regression:lifecycle`;
- token/cost accumulation, pricing, budget enforcement, or root/child accounting:
  `regression:accounting`.

The stabilization gate remains on hold until the issue is closed. A pull request carrying one of the
labels does not replace the issue and does not itself block the gate.

After the initial three-run window is established, main branch protection requires the four
OS/Node matrix checks, package smoke, coverage/UI budgets, and the pull-request `Stability policy`
job. The policy job applies the same run-window and regression-issue rules before new work can merge.

## Operation

Use `workflow_dispatch` on `CI` to repeat the full matrix without introducing empty commits. The
post-CI workflow evaluates the latest three eligible runs automatically. Its job summary records the
exact run IDs, commits, conclusions, and any blocking regression issues.

import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';

// React 19 only lets `act()` take over scheduling when the host declares itself an
// act environment. Without this flag `act` prints "The current testing environment is
// not configured to support act(...)" and silently stops flushing the work it queues,
// so Ink component tests that drive timers inside `act` hang instead of settling.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workerId = process.env.VITEST_POOL_ID ?? '0';
const telemetryRoot = join(tmpdir(), 'book-vitest-tool-telemetry', `${process.pid}-${workerId}`);

process.env.BOOK_TOOL_TELEMETRY_DIR = telemetryRoot;

// BOOK_HOME is deliberately NOT pinned here, unlike the telemetry root above. Its being
// unset is an observable production state rather than an accident: createRunAmbientSnapshot
// attributes `isolation: 'shared'` and reports `book_home_isolation` as a missing source from
// exactly that, and tui/persist.test.ts exercises the homedir() fallback a global pin would
// make unreachable. Suites that must not see the developer's ~/.book pin their own (see
// config.test.ts).

afterAll(() => {
  rmSync(telemetryRoot, { recursive: true, force: true });
});

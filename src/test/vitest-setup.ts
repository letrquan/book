import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';
import { clearInheritedBookEnv, resolveKeptBookEnv } from './inherited-book-env.js';

// React 19 only lets `act()` take over scheduling when the host declares itself an
// act environment. Without this flag `act` prints "The current testing environment is
// not configured to support act(...)" and silently stops flushing the work it queues,
// so Ink component tests that drive timers inside `act` hang instead of settling.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const workerId = process.env.VITEST_POOL_ID ?? '0';
const telemetryRoot = join(tmpdir(), 'book-vitest-tool-telemetry', `${process.pid}-${workerId}`);

process.env.BOOK_TOOL_TELEMETRY_DIR = telemetryRoot;

// Who drives the session is read from the environment (src/session-driver.ts), and the suite is
// often run by an agent — Claude Code sets CLAUDECODE and AI_AGENT, Book sets BOOK_SESSION_DRIVER
// in its children. A test of the human path must not turn into the agent path because of who
// launched `vitest`; the tests of the agent path set these themselves.
delete process.env.CLAUDECODE;
delete process.env.AI_AGENT;
delete process.env.BOOK_SESSION_DRIVER;

// A suite is often run from inside a Book session or a shell that exports BOOK_* overrides
// (BOOK_EFFORT, BOOK_MODEL, BOOK_MAX_TOKENS, ...), and an inherited override outranks the default a
// test asserts (#467). So every BOOK_* variable is deleted here, in every tier, except:
//   - BOOK_HOME and the telemetry root pinned above (see below);
//   - in the integration tier (its config sets VITEST_BOOK_TIER=integration in `test.env`), the
//     provider variables tui-integration.test.ts passes to its PTY child on purpose (#358);
//   - anything named in BOOK_TEST_KEEP_ENV, a comma-separated escape hatch for debugging, e.g.
//       BOOK_TEST_KEEP_ENV=BOOK_DEBUG,BOOK_DEBUG_STDERR npx vitest run src/headless.test.ts
//     BOOK_TEST_KEEP_ENV is read first and then cleared itself, unless it lists itself.
// A test that sets a variable itself does so after this runs and is unaffected.
clearInheritedBookEnv(process.env, resolveKeptBookEnv(process.env));

// BOOK_HOME is deliberately NOT pinned here, unlike the telemetry root above. Its being
// unset is an observable production state rather than an accident: createRunAmbientSnapshot
// attributes `isolation: 'shared'` and reports `book_home_isolation` as a missing source from
// exactly that, and tui/persist.test.ts exercises the homedir() fallback a global pin would
// make unreachable. Suites that must not see the developer's ~/.book pin their own (see
// config.test.ts).

afterAll(() => {
  rmSync(telemetryRoot, { recursive: true, force: true });
});

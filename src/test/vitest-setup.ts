import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll } from 'vitest';

const workerId = process.env.VITEST_POOL_ID ?? '0';
const telemetryRoot = join(tmpdir(), 'book-vitest-tool-telemetry', `${process.pid}-${workerId}`);

process.env.BOOK_TOOL_TELEMETRY_DIR = telemetryRoot;

afterAll(() => {
  rmSync(telemetryRoot, { recursive: true, force: true });
});

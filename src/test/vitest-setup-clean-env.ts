import { clearInheritedBookEnv } from './inherited-book-env.js';

// Setup file for the unit and contract tiers only (see their configs). The integration tier does
// not list it: tui-integration.test.ts hands BOOK_API_KEY, BOOK_BASE_URL, BOOK_PROVIDER, BOOK_MODEL
// and BOOK_EFFORT to its PTY child on purpose, so its streaming tests can use a developer's real
// provider (#358). Runs after `vitest-setup.ts`, so the telemetry root it pins is kept.
clearInheritedBookEnv(process.env);

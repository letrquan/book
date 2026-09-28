/**
 * Default NODE_ENV to "production" before any dependency loads.
 *
 * React and react-reconciler pick their development or production build from
 * NODE_ENV at import time. A CLI normally runs with NODE_ENV unset, which
 * silently loads the development renderer — 2-3x slower per render pass.
 * This must be the first import of the CLI entry so it runs before ink/react
 * are evaluated. An explicitly set NODE_ENV always wins.
 *
 * A default Book invented is marked as one, so `buildChildEnv` can keep it off
 * every command Book starts (`child-env.ts`). Without the marker a child
 * inherits `NODE_ENV=production` from a user who set nothing, and `npm
 * install` in a project drops its devDependencies.
 */
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
  process.env.BOOK_DEFAULTED_NODE_ENV = '1';
}

export {};

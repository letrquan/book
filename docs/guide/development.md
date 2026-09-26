# Developing Book

Working on Book itself: building from a checkout, the test tiers, and releases.

## Working from a checkout

```bash
git clone https://github.com/letrquan/book.git
cd book
npm install
npm run build
npm link   # makes your checkout's `book` the global one
```

New features are built by running Book on itself and watching the change in the real TUI; the
`run-book` skill in `.claude/skills/run-book/` holds the PTY driver, the mock provider, and the smoke
test for that. `bash .claude/skills/run-book/readme-media.sh` regenerates the README's GIF and
screenshots in `docs/media/` the same way, against the mock provider.

## Scripts

```bash
npm run typecheck    # TypeScript check
npm test             # Build, then run unit + contract + integration suites
npm run test:unit    # Deterministic unit suite
npm run test:contract
npm run test:integration # Isolated PTY/process suite (one worker)
npm run check        # Format, lint, types, architecture, unit, and contract checks
npm run test:watch   # Watch mode
npm run test:coverage
npm run build        # tsup → dist/
npm run dev          # Run via tsx
npm run lint         # ESLint
npm run format       # Prettier
npm run format:check
npm run bench:ui     # TUI micro-benchmarks
npm run bench:runtime # Runtime micro-benchmarks
npm run deadcode:check  # knip dead-code scan (non-zero exit on findings)
npm run deadcode:report # knip scan as Markdown (used for the CI job summary)
npm run deadcode:json   # knip scan as JSON
npm run eval:edit    # Edit reliability evaluation (configured provider)
npm run eval:compact # Compaction paired evaluation (configured provider)
npm run eval:skills  # Skill activation evaluation
npm run verify:ink     # Installed Ink matches the release the TUI was verified against
npm run release:check # Version, audit, and package smoke checks
```

Main-branch runtime work also follows the [stabilization gate](../stabilization.md): three
consecutive green full CI runs and no open lifecycle or accounting regression issues.

## Upgrading Ink

Book pins `ink` to an exact version, and `src/cli/ink-renderer.ts` records the release the TUI was
last verified against (`VERIFIED_INK_VERSION`). A bump, including a Dependabot one, fails the
contract test `src/cli/ink-renderer.contract.test.ts` and `npm run verify:ink` until someone:

1. reads the new release's changelog for input, renderer and `render()` option changes;
2. runs `npm run check`, `npm run test:integration` and `npm run bench:ui`;
3. drives the real TUI with the run-book skill's driver on Windows and on a Unix terminal
   (streaming, the transcript grid, a permission sheet, the composer menus, Esc and Ctrl+C,
   resize) and compares `shotpng` shots with the previous release;
4. updates `VERIFIED_INK_VERSION`.

The incremental renderer also needs Ink's trailing-newline fix (upstream issue 909, in Ink 7.0.0
and later). Without it Book falls back to the full-frame renderer.

## Maintenance workflow

`.github/workflows/maintenance.yml` runs the deterministic half of the nightly maintenance work,
daily at 01:00 UTC and on every pull request:

- **Dead-code report** — runs knip against the committed `knip.json` and writes the result to the
  job summary. Report-only: the repository carries a backlog of a few hundred unused exports and
  exported types, and deciding which are safe to remove is a judgment call rather than a gate.
  `knip.json` lists `src/index.ts`, `src/sdk.ts`, and `src/job-runner.ts` as entry points, so the
  published SDK surface is never flagged.
- **Security advisories** — runs `npm audit` on a schedule (not just when someone pushes) and keeps
  a single rolling `Dependency security advisories` issue in sync, opening it when an advisory at
  or above `high` appears, rewriting it as the set changes, and closing it once clear. A scan that
  fails to complete never closes the issue.

## Releasing

`.github/workflows/release.yml` publishes to npm on a `v*` tag, using **trusted publishing**: GitHub
Actions proves the workflow's identity to the registry over OIDC, so no npm token exists to leak or
expire. The workflow refuses a tag that disagrees with `package.json`, then runs `npm run check`,
the integration tier, and `npm run release:check` — which packs the tarball, installs it, and runs
the installed CLI and SDK — before publishing. Provenance is attached automatically.

Cutting a release is therefore:

```bash
# version bump + changelog promotion committed on main
git tag -a v0.3.0 -m "Book 0.3.0"
git push origin v0.3.0
```

The one-time registry side is on npmjs.com under the package's Settings → Trusted Publisher:
organization `letrquan`, repository `book`, workflow filename `release.yml`.

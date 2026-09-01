# Repository Guidelines

## Project Structure & Module Organization

Application code lives in `src/`. The CLI entry point is `src/index.ts`; reusable SDK exports are in `src/sdk.ts`. Feature areas are grouped by responsibility, including `src/agent/` (core loop), `src/agents/` (managed subagents), `src/cli/`, `src/commands/`, `src/provider/`, `src/session/`, `src/tools/`, `src/rewind/`, shared domain types in `src/types/`, and the Ink/React interface in `src/tui/`. Tests are co-located with implementation files as `*.test.ts` or `*.test.tsx`. Documentation and design material live in `docs/` and `plans/`. Build output is generated in `dist/` and should not be edited directly. Repository-local runtime settings belong under `.book/`.

## Build, Test, and Development Commands

- `npm install` installs dependencies; Node.js 22.19 or newer is required.
- `npm run dev` runs the CLI directly from `src/index.ts` with `tsx`.
- `npm run build` bundles JavaScript and declarations into `dist/` with `tsup`.
- `npm run typecheck` checks strict TypeScript types without emitting files.
- `npm test` builds first, then runs the unit, contract, and integration Vitest tiers in sequence.
- `npm run test:unit` / `npm run test:contract` / `npm run test:integration` run a single tier (skip the build while iterating).
- `npm run check` is the fast pre-commit gate: format:check, lint, typecheck, architecture:check, unit, and contract.
- `npm run test:watch` runs tests interactively during development.
- `npm run test:coverage` produces V8 coverage results.
- `npm run lint` and `npm run format:check` validate ESLint and Prettier rules.

## Coding Style & Naming Conventions

Use TypeScript ESM and keep code compatible with the strict settings in `tsconfig.json`. Prettier enforces 2-space indentation, semicolons, single quotes, trailing commas, and a 100-character line width. Use `camelCase` for variables and functions, `PascalCase` for React components and types, and kebab-case filenames such as `settings-loader.ts`. Prefix intentionally unused parameters with `_`. Run formatting, linting, and type checking before submitting changes.

## Testing Guidelines

Vitest is the primary framework; TUI tests also use Ink Testing Library. Place tests beside the code they cover and mirror the implementation filename, for example `src/tools/file.ts` and `src/tools/file.test.ts`. Add focused regression tests for bug fixes and cover success, failure, and boundary behavior. There is no fixed coverage threshold, but avoid reducing meaningful coverage.

## Commit & Pull Request Guidelines

Recent history favors concise, imperative subjects and Conventional Commit prefixes such as `feat:`. Use prefixes like `feat:`, `fix:`, `test:`, `docs:`, or `refactor:` where appropriate. Keep commits scoped to one logical change. Pull requests should explain the problem and solution, list verification commands, link related issues, and include screenshots or terminal captures for visible TUI changes. Update `README.md` or `CHANGELOG.md` when user-facing behavior changes.

## Security & Configuration

Never commit API keys, tokens, or personal `.book` settings. Use environment variables or local configuration for provider credentials, and redact secrets from fixtures, logs, screenshots, and issue reports.

# Release Checklist

Current distribution status: `package.json` is `private: true`, and the unscoped npm name `book` is
not available for this project. Releases are therefore source/GitHub artifacts unless the package
is deliberately renamed (for example to a scoped name) and made publishable.

## Prepare

1. Choose the semantic version and update `package.json` plus `package-lock.json`.
2. Move the applicable `CHANGELOG.md` entries from `Unreleased` into a matching
   `## [x.y.z] - YYYY-MM-DD` section.
3. Run `npm ci` with the `packageManager` version from `package.json`.
4. Run `npm run check`, `npm test`, `npm run test:coverage`, and `npm run bench:ui`.
5. Repeat the full test/package validation on Node.js 22 and 24, including Windows and Ubuntu.
6. Run `npm run release:check` and review `npm pack --dry-run` for secrets, local settings, and
   unexpected files.
7. Confirm the stabilization gate and required GitHub checks are green for the exact release commit.

## Publish

1. Create an annotated `vx.y.z` tag matching `package.json`.
2. Build from the tagged commit and attach the exact tarball validated by the package smoke test to
   the GitHub release.
3. Verify `book --version`, `book doctor`, the SDK import, and MCP client metadata from the
   installed package.
4. Publish release notes from the matching changelog section.

If npm publication is introduced later, first change the package name/visibility intentionally,
document the registry and access level, and publish the already validated tarball rather than a new
build.

## Roll Back

1. Mark the affected GitHub release as withdrawn and document the recommended previous version.
2. Restore the last known-good version in installation guidance; do not rewrite or reuse the tag.
3. Fix forward with a new patch version and changelog entry.
4. Record the failed validation or runtime signal that allowed the regression through.

For a future npm release, also deprecate the affected registry version with the same reason.

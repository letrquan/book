# Release Checklist

## Prepare

1. Choose the semantic version and update `package.json` plus `package-lock.json`.
2. Move the applicable `CHANGELOG.md` entries from `Unreleased` into a matching
   `## [x.y.z] - YYYY-MM-DD` section.
3. Run `npm ci` with a supported npm version and `npm run release:check`.
4. Run `npm test` on Node.js 20 and 24, including at least one Windows run.
5. Review `npm pack --dry-run` output for secrets, local settings, and unexpected files.

## Publish

1. Create an annotated `vx.y.z` tag matching `package.json`.
2. Build from the tagged commit and publish the exact tarball validated by the package smoke test.
3. Verify `book --version`, `book doctor`, the SDK import, and MCP client metadata from the
   installed package.
4. Publish release notes from the matching changelog section.

## Roll Back

1. Deprecate the affected npm version with a reason and the recommended previous version.
2. Restore the last known-good version in installation guidance; do not rewrite or reuse the tag.
3. Fix forward with a new patch version and changelog entry.
4. Record the failed validation or runtime signal that allowed the regression through.

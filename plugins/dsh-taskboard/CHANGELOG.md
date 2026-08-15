# Changelog

## [0.1.1] - 2026-08-15

### Changed
- Published `@suhan-dsh/taskboard@0.1.1` to the public npm registry.
- Deprecated `0.1.0` in favor of `0.1.1`; `0.1.1` is the clean published artifact without local tarball publish metadata.

## [0.1.0] - 2026-08-15

### Added
- Initial public release preparation for `@suhan-dsh/taskboard`.
- MIT license, repository metadata, npm public publish configuration.
- Public marketplace status and refined permission declarations.

### Changed
- Removed `private: true` and `UNLICENSED`; switched to public npm package metadata.
- `exports` no longer exposes unpublished `./src/*` paths.
- Published tarball now includes `lib/client.js.map`, `LICENSE`, and `CHANGELOG.md`.
- README installation instructions now support `dsh plugin --profile web add @suhan-dsh/taskboard`.

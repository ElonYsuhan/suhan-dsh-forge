# Changelog

## [0.1.2] - 2026-08-15

### Added
- Isolate concurrent tasks in task-owned Git worktrees and serialize only final repository integration.
- Automatically create a linked conflict-resolution task when a completed task cannot be integrated safely.
- Add workspace-scoped paginated task history and durable Git commit references.
- Keep a last-known-good data backup and recover from a corrupt primary data file.
- Enforce bounded JSON request bodies and validate work-item, parent, status, type, and settings payloads.

### Fixed
- Preserve taskboard state across refreshes, restarts, upgrades, and reinstall mode changes under `$DSH_HOME/storages/dsh-taskboard`.
- Migrate legacy package-local `datas/boards.json` data non-destructively when it is still available.
- Return actionable Git-workspace precondition errors instead of opaque task-run HTTP 500 responses.
- Recover interrupted task bootstrap workspaces and clean them during deletion or force-close even before session creation completes.
- Allow editing to clear optional parent and iteration fields without leaving stale values.
- Avoid post-unload background state transitions and wait for pending persistence before lifecycle disposal completes.

### Changed
- Remove the manual project creation API and UI; boards now follow the DSH workspace registry only.
- Add keyboard-native task cards, modal focus trapping, Escape close, focus restoration, and visible focus indicators.
- Align DSH peer compatibility with the tested `0.1.0-rc.6` preview runtime and Cordis `4.0.1`.


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

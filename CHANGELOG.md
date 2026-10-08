# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-26

First release. Verified end to end on Windows against DSH `0.1.5-rc.2`: four
plugins were synced from the `web` profile into `desktop`, and DSH Desktop
loaded them after a restart.

### Added

- Cross-profile plugin discovery that classifies every declared bundle as
  `user`, `product`, `desktop-owned`, or `unknown`.
- Dry-run-first CLI (`dsh-profile-sync`) that writes nothing without `--apply`.
- Manifest editing that preserves `version`, `packageManager`, unrelated
  top-level keys, and sibling `dsh.*` keys, changing only `dependencies` and
  `dsh.profile.bundles`.
- Atomic, lock-protected manifest writes with a `.profilesync.bak` backup and a
  stale-lock reclaimer.
- Package-manager stage that resolves a real executable before spawning: native
  `.exe` first, then `.cmd`/`.bat`, never a `.ps1`, and an extensionless POSIX
  script only as a last resort.
- `--check` gate that reports a target as unusable when a declared bundle is
  absent from `node_modules`, not merely when the manifest is wrong.
- Conflicting source specifiers are refused by default; `--allow-conflicts`
  opts into taking the first source's specifier.
- Local `file:`/`link:` specifiers are reported, because copying one retargets
  it relative to the target profile.
- DSH host face that publishes `ctx.dshProfileSync` with `plan()` and `sync()`,
  degrading instead of failing when service registration is unavailable or the
  name is already taken.
- 36 offline tests covering classification, plan idempotency, pruning, atomic
  write failure, lock exclusivity, executable resolution, install failure, BOM
  tolerance, verification semantics, CLI exit codes, and plugin degradation.
- `scripts/check-pack.mjs`, which reproduces npm's file-selection rules, asserts
  the publish metadata, and writes a real installable tarball without invoking
  npm.
- `scripts/check-install.mjs`, which unpacks that tarball into a throwaway
  `node_modules`, resolves every manifest reference, runs the installed bin, and
  loads the host and subpath exports.
- `scripts/release-stamp.mjs` plus `.release-target.json`, so the repository
  identity is an explicit operator statement instead of a placeholder.
- `npm run release:check`, which runs the suite and both artifact checks.
- CI across Linux, macOS, and Windows on Node 22.19 and 24.

[0.1.0]: https://github.com/Wu-Fankai/DSH--/releases/tag/v0.1.0

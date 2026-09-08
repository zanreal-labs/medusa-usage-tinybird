# Changelog

All notable changes to `@zanreal/medusa-usage-tinybird` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

## [Unreleased]

Nothing yet. `main` is at the published version.

## [0.1.0] - 2026-08-27

First public release. MIT, published from CI with npm provenance.

### Added

- **Tinybird sink for `@zanreal/medusa-usage`**: an append-only usage event log in a
  column store. ClickHouse does not enforce uniqueness on insert, so deduplication happens
  where the log is *read*, which is why a retried write cannot double count a period.
- Datasource and pipe definitions shipped in the package under `tinybird/`.
- Standalone resolution of `@zanreal/medusa-usage` by override, so the sink can be
  installed outside the workspace that developed it.

[Unreleased]: https://github.com/zanreal-labs/medusa-usage-tinybird/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zanreal-labs/medusa-usage-tinybird/releases/tag/v0.1.0

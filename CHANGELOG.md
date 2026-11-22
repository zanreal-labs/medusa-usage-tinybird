# Changelog

All notable changes to `@zanreal/medusa-usage-tinybird` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-11-22

### Changed

- **Built and tested against Medusa 2.23.0** (was 2.18.0 in 0.1.1): the `@medusajs/framework`
  peer pins 2.23.0, and the `@zanreal/medusa-usage` peer is now `>=0.2.0`, the first release
  built against the same Medusa. Install alongside Medusa 2.23.0 and stay on 0.1.1 with older
  hosts. Node.js 22.22 or newer is required, as Medusa 2.23 itself requires.
- Dependency updates now come from Renovate, run weekly by the `zanek-ai` app from
  `.github/workflows/renovate.yml`.

## [0.1.1] - 2026-09-08

### Changed

- Keywords carry `medusa-plugin-integration`, `medusa-plugin` and a category word,
  so the package is eligible for the Medusa integrations directory at
  <https://medusajs.com/integrations>, which is scraped from npm. Without them the
  package could not be picked up at all.

### Added

- This changelog, shipped in the published tarball.

## [0.1.0] - 2026-08-27

First public release. MIT, published from CI with npm provenance.

### Added

- **Tinybird sink for `@zanreal/medusa-usage`**: an append-only usage event log in a
  column store. ClickHouse does not enforce uniqueness on insert, so deduplication happens
  where the log is *read*, which is why a retried write cannot double count a period.
- Datasource and pipe definitions shipped in the package under `tinybird/`.
- Standalone resolution of `@zanreal/medusa-usage` by override, so the sink can be
  installed outside the workspace that developed it.

[Unreleased]: https://github.com/zanreal-labs/medusa-usage-tinybird/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zanreal-labs/medusa-usage-tinybird/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/zanreal-labs/medusa-usage-tinybird/releases/tag/v0.1.1
[0.1.0]: https://github.com/zanreal-labs/medusa-usage-tinybird/releases/tag/v0.1.0

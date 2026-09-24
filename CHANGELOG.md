# Changelog

All notable changes to `@zanreal/medusa-usage-tinybird` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A version
reaches npm only through a GitHub Release, so the dates below are publish dates on the
registry, not merge dates on `main` - see [Releasing](./README.md#releasing).

## [Unreleased]

### Changed

- **Built and tested against Medusa 2.21.1** (was 2.18.0), with the admin toolchain Medusa 2.19
  requires: Vite 7 and, where used, React Router 7. `react-i18next` and `i18next` deliberately stay
  on the majors the Medusa dashboard itself ships (13 and 23): admin extensions share the host's
  i18n instance, and a second major would give them one of their own. Install alongside Medusa
  2.21.1; Node ^20.19 or ^22.12 is required from Medusa 2.19 on.

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

[Unreleased]: https://github.com/zanreal-labs/medusa-usage-tinybird/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/zanreal-labs/medusa-usage-tinybird/releases/tag/v0.1.1
[0.1.0]: https://github.com/zanreal-labs/medusa-usage-tinybird/releases/tag/v0.1.0

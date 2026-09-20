# Changelog

## [0.2.0] — 2026-09-20

Reports for any cadence: metrics-only weekly/monthly, reviews-only —
all in one call, both platforms, per branch.

### Added

- **`collectMetrics()`** — a metrics-only report (no reviews) of both
  platforms: chain totals as cards + a per-branch table per platform,
  grouped by service. The period is set by `daysBack`:
  a number of days ending yesterday (7 = yesterday-6..yesterday),
  `'week'` — a readable alias of the same trailing 7 days, `'month'` —
  the whole previous calendar month (any September run covers 01..31
  August). Writes `metrics_report.json` / `weekly_report.json` /
  `monthly_report.json`; sends the email with `sendEmail: true`.
- **`collectReviews()`** — reviews of BOTH platforms in ONE combined
  email (`sendEmail: true`, subject "Reviews report ..." /
  "Отчёт по отзывам ...").
- **Per-branch metrics**: `getYandexStats()` now returns `.branches`
  (via the `ym:s:vacuumOrganization` Metrika dimension), `getGoogleStats()`
  returns `.branches` (metrics are already fetched per location).
- **`branches.json` aliases both platforms**: the keys match Google
  addresses AND Yandex Metrika organization names (both the full
  "Region, City, street..." spelling and the street part), so branches
  are named uniformly — add both street spellings when they differ.
- `sendMetricsEmail()` / `sendReviewsEmail()` exports for manual sending;
  `dateFrom` / `dateTo` — an exact custom period for the metrics collectors.
- Metrics email layout: per-service sections (totals cards + the
  service's branch table right after), compact zebra-striped tables,
  one-line branch names.

### Changed

- README fully rewritten for the new API.
- `MetrikaDaily` / `GoogleStats` gained the `branches` field.

### Removed

- The gray subtitle line in report emails.
- The `reportFile` option and the `RunReportOptions` interface — every
  run writes its standard JSON file (`daily_report.json`,
  `metrics_report.json`, `weekly_report.json`, `monthly_report.json`),
  overwritten by the next run of the same kind.

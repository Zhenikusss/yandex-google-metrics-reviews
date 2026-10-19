# Changelog

## [0.3.0] — 2026-10-19

Yandex started serving an antibot captcha on the first Maps visit (and to
every datacenter/CI IP — permanently). The Yandex collector is now
captcha-aware, and a Yandex failure no longer kills the whole report.

### Added

- **Automatic captcha pass in the Yandex reviews collector**: the captcha
  page is detected explicitly (the `show_captcha` redirect, SmartCaptcha or
  the classic form) and the challenge checkbox is ticked automatically
  with a trusted Playwright click (synthetic `element.click()` is ignored
  by captcha widgets); the tick is retried until the challenge clears —
  up to `YANDEX_CAPTCHA_WAIT_MS` (default 120s, `0` — fail immediately).
  A timeout produces a dedicated error with a `debug_captcha.png`
  screenshot instead of the misleading "no branches found".
- **Persistent browser profile** (`YANDEX_PROFILE_DIR`, default
  `.yandex-profile` in the working directory): the captcha clearance
  cookies survive between runs. If a solved captcha lands the browser
  off the chain page, the collector returns to it and re-checks.
- Captcha check on branch review pages too, and a `debug_fail_chain.png`
  screenshot when the branch list is empty.
- **`MAIL_ERRORS_TO`**: partial reports (a platform failed to collect)
  now go ONLY to this recipient list — the developer — instead of
  `MAIL_TO`, with a "⚠ Частичный отчёт (сбой сбора)" /
  "⚠ Partial report (collection failed)" prefix in the subject; without
  it they fall back to `MAIL_TO` with a warning in the logs.
- **Failure isolation of the Yandex side** (was Google-only):
  `collectReviews()` and `runReport()` no longer crash when the Yandex
  collection fails — the email goes out with what was collected plus a
  red warning line about the missing side; only a failure of BOTH
  platforms throws (`collectReviews()` result: `yandex` is now `| null`).

### Changed

- The reviews email shows an explicit warning when a platform section is
  missing because its collection failed.

### Fixed

- Debug screenshots are saved into the working directory (next to the
  report JSON files) and PNG files are excluded from the npm package —
  0.2.0 accidentally shipped runtime `debug_fail_*.png` screenshots
  inside `dist/`.

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

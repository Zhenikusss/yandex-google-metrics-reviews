# yandex-google-metrics-reviews

Chain metrics and reviews from Yandex Maps and Google Maps — in one call.
A full daily report (JSON + email), a metrics-only report (weekly/monthly)
or a reviews-only email — all from one library.

## Features

- **Yandex Metrika (Business):** profile views, direction requests,
  call clicks, website clicks — summed across the chain
- **Google Business Profile:** profile views, directions, calls,
  website clicks — summed across all account locations
- **Per-branch metrics** of both platforms with the same fields
  (Yandex via the `ym:s:vacuumOrganization` dimension, Google per location)
- **Metrics-only report** — `collectMetrics({ daysBack: 'week' | 'month' | 7, sendEmail: true })`:
  chain totals as cards + a per-branch table per platform, grouped by service
- **Reviews — Yandex Maps:** per branch (author, rating, date, text)
- **Reviews — Google:** the same, via the official API
- **Report emails** to every recipient (a separate email each): the full
  report, the metrics-only report or the reviews-only report — with the
  same data in the JSON files
- **Failures are isolated:** a Google failure never breaks the Yandex
  part — the report is sent with what was collected

## Install

```bash
npm install yandex-google-metrics-reviews
```

Yandex reviews use Playwright — install the browser on first run:

```bash
npx playwright install chromium
```

## Library usage

```ts
import {
  runReport,              // full run: all sources -> daily_report.json -> email
  collectMetrics,         // METRICS of BOTH platforms -> JSON -> optional email
  collectReviews,         // reviews of BOTH platforms -> optional email
  getYandexStats,         // Yandex Metrika metrics (totals + per branch)
  getGoogleStats,         // Google Business Profile metrics (totals + per branch)
  collectYandexReviews,   // Yandex Maps reviews
  collectGoogleReviews,   // Google reviews
  sendReportEmail,        // email with a ready report (manual sending)
  sendReviewsEmail,       // reviews-only email (manual sending)
  sendMetricsEmail,       // metrics-only email (manual sending)
} from 'yandex-google-metrics-reviews';

// 1) the full daily report: all metrics + all reviews of both platforms
//    -> daily_report.json + email (always sent)
await runReport({ lang: 'ru', brand: 'My Chain' });

// 2) metrics only (no reviews): chain totals + per-branch tables
//    of both platforms, grouped by service. The period is set by daysBack:
await collectMetrics({ daysBack: 7, sendEmail: true, lang: 'ru' });       // the last 7 days ending yesterday
await collectMetrics({ daysBack: 'week', sendEmail: true, lang: 'ru' });  // the same trailing 7 days (a readable alias)
await collectMetrics({ daysBack: 'month', sendEmail: true, lang: 'ru' }); // the whole previous calendar month
// without sendEmail (default) — only the JSON file, no email

// 3) reviews only: reviews of both platforms in ONE email
await collectReviews({ daysBack: 1, sendEmail: true, lang: 'ru' });

// per-platform collectors without emails:
const metrika = await getYandexStats({ daysBack: 3 });   // MetrikaDaily (+ .branches)
const google = await getGoogleStats({ daysBack: 3 });    // GoogleStats (+ .branches)
const yr = await collectYandexReviews({ daysBack: 1 });  // opens a visible browser
const gr = await collectGoogleReviews({ daysBack: 1 });
```

### Call options

| Option | Meaning | Default |
|---|---|---|
| `daysBack` | how many days back to collect: 1 = yesterday | `1` |
| `daysBack` (collectMetrics) | a number of days ending yesterday; `'week'` — a readable alias of the same trailing 7 days (run on a Thursday -> the previous Thu..Wed); `'month'` — the whole previous calendar month (any September run covers 01..31 August) | `1` |
| `lang` | report email language: `'ru'` or `'en'` | `'en'` |
| `brand` | sender name; in the subject — in quotes after the report word: `Report "My Chain" for 15.09.2026`, `Metrics report "My Chain" from 08.09.2026 to 14.09.2026`, `Reviews report "My Chain" for 19.09.2026` | `'Report'` / `'Отчёт'` (by language) |
| `sendEmail` | `collectReviews` / `collectMetrics`: send the email after collecting (`runReport` always emails) | `false` (collect only) |
| `dateFrom` / `dateTo` | `collectMetrics` / `getYandexStats` / `getGoogleStats`: an exact custom period, YYYY-MM-DD (overrides `daysBack`) | not set |

### JSON files

Every run writes its report into the current directory, overwriting the
previous one:

| Run | File |
|---|---|
| `runReport()` | `daily_report.json` |
| `collectMetrics({ daysBack: 7 })` | `metrics_report.json` |
| `collectMetrics({ daysBack: 'week' })` | `weekly_report.json` |
| `collectMetrics({ daysBack: 'month' })` | `monthly_report.json` |

## Command usage

```bash
npx yandex-google-metrics-reviews
```

Runs the full daily report: all sources -> `daily_report.json` of the
current directory -> email when mail is configured.

## Structure

```
index.ts                    runReport, collectMetrics, collectReviews + exports
options.ts                  the shared call options
branches.ts                 branch names: platform address -> report name
branches.json               branch names: Google/Yandex address -> report name
mailer.ts                   HTML emails: full, reviews-only, metrics-only
yandex-parser/
  metrika.ts                Yandex Metrika metrics, totals + per branch (API)
  reviews.ts                Yandex Maps reviews (page scraping via Playwright)
google-parser/
  auth.ts                   Google OAuth token + the account location list
  metrika.ts                Google Business Profile metrics, totals + per branch
  reviews.ts                Google reviews (My Business API, batchGetReviews)
```

## How it works

- **Yandex:** metrics via the official Metrika API (the counter linked to
  the organization card; per-branch breakdown — the
  `ym:s:vacuumOrganization` dimension). Yandex has no reviews API, so
  reviews are scraped from the map pages in a visible browser (Yandex
  serves a "limited" stub to headless ones). A browser window opens —
  that is expected.
- **Google:** both metrics and reviews via official APIs with a refresh
  token. Metrics are fetched per location and summed (each location's row
  is kept for the per-branch table). The location list is live: a newly
  shared location shows up automatically.
- Branch names are unified between the platforms (`branches.json`;
  without a match the address is cleaned automatically).
- Google reviews arrive with an exact creation time; the text is cleaned
  of the autotranslation wrapper (the original as the author wrote it).
- Emails: every recipient from `MAIL_TO` gets a separate copy. When mail
  is not configured the email is skipped with a warning — collection
  itself is not considered failed.

## Configuration

The report period is a call parameter. Everything else lives in `.env`
next to your code (see `.env.example`).

### Yandex

| Variable | Meaning | Where to get it |
|---|---|---|
| `YANDEX_METRIKA_TOKEN` | OAuth token with Metrika API access | id.yandex.ru -> Security |
| `YANDEX_COUNTER_ID` | Metrika counter id linked to the organization card | metrica.yandex.ru -> counter list |
| `YANDEX_CHAIN_URL` | your chain page URL on Yandex Maps — the source of the branch list | open your chain on Yandex Maps and copy the page address |

### Yandex page locale

The reviews collector is locale-independent: the sort menu on the reviews
page is operated structurally (by its CSS classes and the fixed option
order), and the fallback links are derived from your `YANDEX_CHAIN_URL`
domain — no extra configuration for non-Russian pages is needed.

### Google

| Variable | Meaning | Where to get it |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id from Google Cloud Console | console.cloud.google.com -> APIs & Services -> Credentials |
| `GOOGLE_CLIENT_SECRET` | the same client's secret | next to the Client ID |
| `GOOGLE_REFRESH_TOKEN` | long-lived refresh token — fresh access tokens are derived from it | [OAuth Playground](https://developers.google.com/oauthplayground): gear icon -> "Use your own OAuth credentials" -> your client_id/secret -> authorize with scope `business.manage` -> "Exchange authorization code for tokens" -> the `refresh_token` string |

The refresh token lives until revoked when the Cloud Console consent
screen is in "Publish app" status (in "Testing" mode the token dies
after 7 days).

The Google Cloud project must have these APIs enabled: Business Profile
Performance API, My Business Account Management API, My Business
Information API, My Business API. Performance API access is by
application (approved by Google).

### Email

| Variable | Meaning | Where to get it |
|---|---|---|
| `SMTP_HOST` | SMTP server of the sender mailbox | Yandex: `smtp.yandex.ru`, Gmail: `smtp.gmail.com`, Mail.ru: `smtp.mail.ru` |
| `SMTP_PORT` | SMTP port (465 = SSL) | usually `465` |
| `SMTP_USER` | sender mailbox, full address | your email address |
| `SMTP_PASS` | app password (NOT the main mailbox password) | Yandex: id.yandex.ru -> Security -> App passwords; Gmail: myaccount.google.com/apppasswords (2FA required) |
| `MAIL_TO` | recipients, comma-separated | each gets a separate email; recipients do not see each other |

### Branch names

`branches.json` in your current directory (see `branches.example.json`):
key — a substring of the platform address, value — the branch name in the
report. The keys match Google addresses AND Yandex Metrika organization
names (both the full "Region, City, street..." spelling and the street
part), so one file names the branches of both platforms uniformly — add
both spellings when they differ (e.g. "Ленина" and "Леніна").
No file or no match — the address is cleaned automatically
(street with house number).

## Scheduling

The library does not impose a scheduler: `runReport()`,
`collectMetrics()` and `collectReviews()` are plain async functions —
run them from system cron, Task Scheduler, a CI pipeline or a cloud
scheduler. Typical cadence: the full report every morning,
`collectMetrics({ daysBack: 'week', sendEmail: true })` on Tuesdays
(the trailing 7 days ending yesterday = the past Tue..Mon) and
`daysBack: 'month'` on the 1st — the month period is anchored to the
calendar and gives the same result on any day of the month.

Note: the Yandex reviews part needs a visible browser, so schedule it
in a user session (not a headless service).

## License

MIT — see [LICENSE](LICENSE).

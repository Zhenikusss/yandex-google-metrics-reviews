# yandex-google-metrics-reviews

Chain metrics and reviews from Yandex Maps and Google Maps — in one call.
A full period report (JSON + email) or individual sources as a library.

## Features

- **Yandex Metrika (Business):** profile views, direction requests,
  call clicks, website clicks — summed across the chain
- **Google Business Profile:** profile views, directions, calls,
  website clicks — summed across all account locations
- **Per-branch metrics** of both platforms (Yandex via the
  `ym:s:vacuumOrganization` dimension, Google per location)
- **Metrics-only report** — `collectMetrics({ daysBack: 7, sendEmail: true })`:
  chain totals + a per-branch table of both platforms in one email
- **Reviews — Yandex Maps:** per branch (author, rating, date, text)
- **Reviews — Google:** the same, via the official API
- **Report email** to every recipient (a separate email each) —
  optional, JSON alone is fine too; `collectReviews({ sendEmail: true })`
  sends one reviews-only email with the reviews of both platforms

The period is set by the `daysBack` parameter of any function
(default 1 — yesterday) and applies to all sources at once.

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
  collectMetrics,         // METRICS of BOTH platforms + one metrics-only email
  collectReviews,         // reviews of BOTH platforms + one reviews-only email
  getYandexStats,         // Yandex Metrika metrics
  collectYandexReviews,   // Yandex Maps reviews
  getGoogleStats,         // Google Business Profile metrics
  collectGoogleReviews,   // Google reviews
  sendReportEmail,        // email with a ready report
  sendReviewsEmail,       // reviews-only email
  sendMetricsEmail,       // metrics-only email
} from 'yandex-google-metrics-reviews';

// everything at once, for yesterday (default)
const report = await runReport();

// a 7-day report into a specific file, Russian email, custom brand
const weekly = await runReport({
  daysBack: 7,
  reportFile: 'weekly.json',
  lang: 'ru',
  brand: 'My Chain',
});

// METRICS ONLY (no reviews): chain totals + per-branch table of both
// platforms -> metrics_report.json + one email
await collectMetrics({ daysBack: 7, sendEmail: true, lang: 'ru', brand: 'My Chain' });
// schedule it on Tuesdays: daysBack 7 = (yesterday - 6) .. yesterday,
// i.e. exactly the past Tuesday..Monday

// reviews of both platforms + ONE email with them together
const all = await collectReviews({ daysBack: 1, sendEmail: true });

// ...or without the email, and per platform
const metrika = await getYandexStats({ daysBack: 3 });
const reviews = await collectGoogleReviews({ daysBack: 3 });
```

### Call options

| Option | Meaning | Default |
|---|---|---|
| `daysBack` | how many days back to collect: 1 = yesterday | `1` |
| `lang` | report email language: `'ru'` or `'en'` | `'en'` |
| `brand` | sender name; in the subject — in quotes after the word Report/Отчёт: `Report "My Chain" for 15.09.2026` | `'Report'` / `'Отчёт'` (by language) |
| `sendEmail` | `collectReviews` / `collectMetrics`: send the combined email of both platforms after collecting (`runReport` always emails) | `false` (collect only) |
| `reportFile` | where to write the report JSON (`runReport`, `collectMetrics`) | `daily_report.json` / `metrics_report.json` in the current directory |

The metrics-only email subject is `Metrics report "My Chain" from 15.09.2026 to 21.09.2026` /
`Отчёт по метрикам «My Chain» с 15.09.2026 по 21.09.2026` (single day: `for 19.09.2026` / `за 19.09.2026`).

## Command usage

```bash
npx yandex-google-metrics-reviews
```

Collects the full report into `daily_report.json` of the current
directory and sends the email when mail is configured.

## Structure

```
index.ts                    full run, combined reviews + metrics report + exports
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

- **Yandex:** metrics via the official Metrika API; Yandex has no reviews
  API, so reviews are scraped from the map pages in a visible browser
  (Yandex serves a "limited" stub to headless ones). A browser window
  opens — that is expected.
- **Google:** both metrics and reviews via official APIs with a refresh
  token. The Google location list is live: a newly shared location
  shows up in metrics and reviews automatically.
- Branch names are unified between Yandex and Google (`branches.json`;
  without a match the address is cleaned automatically).
- Google reviews arrive with an exact creation time; the text is cleaned
  of the autotranslation wrapper (the original as the author wrote it).

## Configuration

The report period is the `daysBack` call parameter (default 1 = yesterday).
Everything else lives in `.env` next to your code (see `.env.example`).

### Yandex

| Variable | Meaning | Where to get it |
|---|---|---|
| `YANDEX_METRIKA_TOKEN` | OAuth token with Metrika API access | id.yandex.ru -> Security |
| `YANDEX_COUNTER_ID` | Metrika counter id linked to the organization card | metrica.yandex.ru -> counter list |
| `YANDEX_CHAIN_URL` | your chain page URL on Yandex Maps — the source of the branch list | open your chain on Yandex Maps and copy the page address |

### Yandex page locale

The collector is locale-independent: the sort menu on the reviews page
is operated structurally (by its CSS classes and the fixed option
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

### Email (optional)

| Variable | Meaning | Where to get it |
|---|---|---|
| `SMTP_HOST` | SMTP server of the sender mailbox | Yandex: `smtp.yandex.ru`, Gmail: `smtp.gmail.com`, Mail.ru: `smtp.mail.ru` |
| `SMTP_PORT` | SMTP port (465 = SSL) | usually `465` |
| `SMTP_USER` | sender mailbox, full address | your email address |
| `SMTP_PASS` | app password (NOT the main mailbox password) | Yandex: id.yandex.ru -> Security -> App passwords; Gmail: myaccount.google.com/apppasswords (2FA required) |
| `MAIL_TO` | recipients, comma-separated | each gets a separate email; recipients do not see each other |

The email language and brand are call parameters of
`runReport`/`sendReportEmail` (`lang: 'ru' | 'en'`, `brand: string`;
defaults — English, "Report").

### Branch names

`branches.json` in your current directory (see `branches.example.json`):
key — a substring of the platform address, value — the branch name in the
report. The keys match Google addresses AND Yandex Metrika organization
names (both the full "Region, City, street..." spelling and the street
part), so one file names the branches of both platforms uniformly — add
both spellings when they differ (e.g. "Строителей" and "Будаўнікоў").
No file or no match — the address is cleaned automatically
(Google: street with house number; Yandex: street with house number).

## Scheduling

The library does not impose a scheduler: `runReport()`,
`collectMetrics()` and `collectReviews()` are plain async functions —
run them from system cron, Task Scheduler, a CI pipeline or a cloud
scheduler. All periods are relative to the run date: `daysBack: 7`
covers (yesterday - 6) .. yesterday, so a Tuesday run of
`collectMetrics({ daysBack: 7, sendEmail: true })` is exactly the past Tue..Mon week.

## License

MIT — see [LICENSE](LICENSE).

#!/usr/bin/env node
/**
* Main module: the full report in one call.
*
* Collects data from all sources, writes daily_report.json and sends
* an email to MAIL_TO recipients (when mail is configured).
*
* As a library:
*   import { runReport, collectMetrics, collectReviews,
*            getYandexStats, collectYandexReviews, getGoogleStats,
*            collectGoogleReviews, sendReportEmail, sendReviewsEmail,
*            sendMetricsEmail }
*     from 'yandex-google-metrics-reviews';
*
* collectReviews({ sendEmail: true }) collects reviews from both platforms
* and sends ONE reviews-only email ("Reviews report ..." /
* "Отчёт по отзывам ...").
* collectMetrics({ daysBack, sendEmail: true }) does the same for the
* METRICS of both platforms (totals + per branch): daysBack is a number
* of days ending yesterday, 'week' — a readable alias of the same
* trailing 7 days, 'month' — the whole previous calendar month; the JSON
* goes to metrics_report.json / weekly_report.json / monthly_report.json.
*
* As a command: npx yandex-google-metrics-reviews
*/

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { getYandexStats } from './yandex-parser/metrika.js';
import type { MetrikaDaily } from './yandex-parser/metrika.js';
import { collectYandexReviews } from './yandex-parser/reviews.js';
import type { ReviewsCollection } from './yandex-parser/reviews.js';
import { getGoogleStats } from './google-parser/metrika.js';
import type { GoogleStats } from './google-parser/metrika.js';
import { collectGoogleReviews } from './google-parser/reviews.js';
import type { GoogleReviewsCollection } from './google-parser/reviews.js';
import { sendReportEmail, sendReviewsEmail, sendMetricsEmail } from './mailer.js';
import type { ReportOptions, ReviewsOptions, MetricsOptions } from './options.js';

// ---- public API ----
export { getYandexStats } from './yandex-parser/metrika.js';
export type { MetrikaDaily } from './yandex-parser/metrika.js';
export { collectYandexReviews } from './yandex-parser/reviews.js';
export type { ReviewsCollection, BranchResult as YandexBranchResult } from './yandex-parser/reviews.js';
export { getGoogleStats } from './google-parser/metrika.js';
export type { GoogleStats } from './google-parser/metrika.js';
export { collectGoogleReviews } from './google-parser/reviews.js';
export type { GoogleReviewsCollection, GoogleBranchResult } from './google-parser/reviews.js';
export { sendReportEmail } from './mailer.js';
export type { DailyReport } from './mailer.js';
export { sendReviewsEmail } from './mailer.js';
export type { ReviewsEmailSections } from './mailer.js';
export { sendMetricsEmail } from './mailer.js';
export type { MetricsEmailReport } from './mailer.js';
export { DEFAULT_DAYS_BACK, DEFAULT_LANG, DEFAULT_BRAND } from './options.js';
export type { ReportOptions, ReportLanguage, ReviewsOptions, MetricsOptions, MetricsPeriod } from './options.js';
export type { YandexBranchMetrics } from './yandex-parser/metrika.js';
export type { GoogleBranchMetrics } from './google-parser/metrika.js';

/** Result of collectReviews: both platforms, Google null when it failed. */
export interface AllReviewsCollection {
  yandex: ReviewsCollection;
  /** null when the Google collection failed (logged, does not break the run) */
  google: GoogleReviewsCollection | null;
}

/**
 * Reviews from BOTH platforms in one call: Yandex Maps (browser scraping)
 * and Google Maps (official API). A Google failure does not break the
 * Yandex part. With sendEmail: true sends ONE reviews-only email with
 * both sections together ("Reviews report ..." / "Отчёт по отзывам ...").
 */
export async function collectReviews(opts: ReviewsOptions = {}): Promise<AllReviewsCollection> {
  const yandex = await collectYandexReviews(opts);

  let google: GoogleReviewsCollection | null = null;
  try {
    google = await collectGoogleReviews(opts);
  } catch (e) {
    console.error(`[Google] Collection failed, the reviews email will skip Google: ${e instanceof Error ? e.message : e}`);
  }

  // one email with both platforms; without sendEmail — collect only
  if (opts.sendEmail) {
    await sendReviewsEmail(
      {
        reviews: { total: yandex.total, branches: yandex.branches },
        reviewsGoogle: google ? { total: google.total, branches: google.branches } : undefined,
      },
      opts,
    );
  }

  return { yandex, google };
}

/** The metrics collection of both platforms, Google null when it failed. */
export interface MetricsCollection {
  date: string;   // first day of the period
  dateTo: string; // last day of the period
  generatedAt: string;
  yandex: MetrikaDaily;       // totals + branches
  google: GoogleStats | null; // totals + branches; null — collection failed (logged)
}

/** YYYY-MM-DD in local time */
function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The previous calendar month: run on ANY day of September ->
 * August 1 .. August 31 (the year rolls over correctly in January).
 */
function getLastMonthRange(today: Date = new Date()): { start: string; end: string } {
  const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const end = new Date(firstOfThisMonth.getFullYear(), firstOfThisMonth.getMonth(), 0); // last day of the previous month
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { start: fmtDate(start), end: fmtDate(end) };
}

/**
 * Shared body of the metrics collections: both platforms -> JSON file ->
 * optional email. `range` pins the exact period ('month');
 * without it the collectors derive it from daysBack.
 */
async function collectMetricsFor(
  opts: MetricsOptions,
  range: { start: string; end: string } | null,
  defaultFileName: string,
): Promise<MetricsCollection> {
  const periodOpts = range ? { ...opts, dateFrom: range.start, dateTo: range.end } : opts;

  const yandex = await getYandexStats(periodOpts);

  let google: GoogleStats | null = null;
  try {
    google = await getGoogleStats(periodOpts);
  } catch (e) {
    console.error(`[Google] Metrics not collected, the report will skip them: ${e instanceof Error ? e.message : e}\n`);
  }

  const report: MetricsCollection = {
    date: yandex.date,
    dateTo: yandex.dateTo,
    generatedAt: new Date().toISOString(),
    yandex,
    google,
  };

  const file = path.join(process.cwd(), defaultFileName);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report saved: ${file}`);

  // the email — only when asked (sendEmail: true), like collectReviews
  if (opts.sendEmail) {
    await sendMetricsEmail(report, { brand: opts.brand, lang: opts.lang });
  }

  return report;
}

/**
 * Metrics of BOTH platforms in one call (no reviews): Yandex + Google
 * chain totals and a per-branch breakdown with the same fields.
 * Writes a JSON file (metrics_report.json / weekly_report.json /
 * monthly_report.json by the period kind); with sendEmail: true also
 * sends the metrics-only email ("Metrics report ..." / "Отчёт по
 * метрикам ..."). A Google failure does not break the Yandex part.
 *
 * The period, set by daysBack:
 *   a number — that many days back ending yesterday (7 = yesterday-6..yesterday);
 *   'week'  — a readable alias of the same trailing 7 days ending yesterday
 *             (run on a Thursday -> the previous Thursday..Wednesday);
 *   'month' — the whole PREVIOUS calendar month (any September day -> 01..31 August).
 */
export async function collectMetrics(opts: MetricsOptions = {}): Promise<MetricsCollection> {
  const period = opts.daysBack;
  const isMonth = period === 'month';
  const isWeek = period === 'week';

  // 'week' == the trailing 7 days; the keyword only picks the JSON file name
  const effOpts: MetricsOptions = isWeek
    ? { ...opts, daysBack: 7 }
    : isMonth
      ? { ...opts, daysBack: undefined }
      : opts;
  const range = isMonth ? getLastMonthRange() : null;
  const defaultFile = isMonth ? 'monthly_report.json' : isWeek ? 'weekly_report.json' : 'metrics_report.json';

  console.log('========================================');
  console.log(range ? `Metrics: ${range.start} .. ${range.end}` : 'Metrics collection');
  console.log('========================================\n');

  return collectMetricsFor(effOpts, range, defaultFile);
}

/**
 * Full run: all sources -> daily_report.json -> email.
 * Failures of the Google sources do not break the Yandex part of the report.
 */
export async function runReport(opts: ReportOptions = {}): Promise<Record<string, unknown>> {
  console.log('========================================');
  console.log('Data collector started');
  console.log('========================================\n');

  // 1. Yandex Metrika
  console.log('[1/4] Collecting Yandex Metrika stats...');
  const metrika = await getYandexStats(opts);
  console.log(`   route: ${metrika.route}, call: ${metrika.call}, site: ${metrika.site}, showOrg: ${metrika.showOrg}\n`);

  // 2. Google Business metrics (a failure must not break the report)
  console.log('[2/4] Collecting Google Business Profile metrics...');
  let googleStats: Awaited<ReturnType<typeof getGoogleStats>> | null = null;
  try {
    googleStats = await getGoogleStats(opts);
    console.log(`   profile: ${googleStats.profileViews}, site: ${googleStats.siteClicks}, calls: ${googleStats.calls}, directions: ${googleStats.directionRequests}\n`);
  } catch (e) {
    console.error(`[Google] Metrics not collected, the report will skip them: ${e instanceof Error ? e.message : e}\n`);
  }

  // 3. Yandex reviews
  console.log('[3/4] Collecting Yandex Maps reviews...');
  const reviews = await collectYandexReviews(opts);
  console.log(`   total reviews: ${reviews.total}\n`);

  // 4. Google reviews (a failure must not break the report)
  console.log('[4/4] Collecting Google Maps reviews...');
  let googleReviews: Awaited<ReturnType<typeof collectGoogleReviews>> | null = null;
  try {
    googleReviews = await collectGoogleReviews(opts);
    console.log(`   total reviews: ${googleReviews.total}\n`);
  } catch (e) {
    console.error(`[Google] Collection failed, the report will skip Google reviews: ${e instanceof Error ? e.message : e}\n`);
  }

  // 5. The combined report (failures are not written to the file — logs only)
  const report: Record<string, unknown> = {
    date: metrika.date,
    dateTo: metrika.dateTo,
    generatedAt: new Date().toISOString(),
    metrika,
    reviews: {
      total: reviews.total,
      branches: reviews.branches,
    },
  };
  if (googleStats) report.google = googleStats;
  if (googleReviews) {
    report.reviewsGoogle = {
      total: googleReviews.total,
      branches: googleReviews.branches,
    };
  }

  const file = path.join(process.cwd(), 'daily_report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`Report saved: ${file}`);

  // 6. Email (internal skips go to the logs only)
  await sendReportEmail(report as any, { brand: opts.brand, lang: opts.lang });

  console.log('\n========================================');
  console.log('Done!');
  console.log('========================================');

  return report;
}

// run as a command — only when the file is executed directly; an import runs nothing
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: npx yandex-google-metrics-reviews');
    console.log('Runs the full report for yesterday: all sources -> daily_report.json -> email.');
    console.log('Options (daysBack, lang, brand) are available via the library API — see the README.');
    process.exit(0);
  }
  runReport().catch((e) => {
    console.error('Fatal error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

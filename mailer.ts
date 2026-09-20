/**
 * Sends the report as an HTML email: the full one (sendReportEmail) or
 * reviews-only (sendReviewsEmail — one email with the reviews of BOTH
 * platforms, used by collectReviews with sendEmail: true).
 * Settings come from .env:
 *   SMTP_HOST / SMTP_PORT — your email provider's SMTP server and port
 *   SMTP_USER / SMTP_PASS — sender mailbox login and APP PASSWORD
 *   MAIL_TO               — recipient address(es), comma-separated
 * The language and brand of the email come from the call options
 * (lang: 'ru' | 'en', brand: string).
 * If mail is not configured the email is skipped with a warning;
 * data collection is not considered failed.
 */

import nodemailer from 'nodemailer';
import type { ReportOptions, ReportLanguage } from './options.js';
import { DEFAULT_LANG, DEFAULT_BRAND, DEFAULT_DAYS_BACK } from './options.js';

export interface DailyReport {
  date: string;   // first day of the period
  dateTo: string; // last day of the period (equals date for a single-day report)
  generatedAt: string;
  metrika: {
    route: number;
    call: number;
    site: number;
    showOrg: number;
    events: Record<string, number>;
  };
  reviews: {
    total: number;
    branches: {
      branch: string;
      orgId: string;
      reviewsCount: number;
      reviews: { author: string; rating: number | null; date: string; text: string }[];
    }[];
  };
  reviewsGoogle?: {
    total: number;
    branches: {
      branch: string;
      reviewsCount: number;
      reviews: { author: string; rating: number | null; date: string; dateText?: string; text: string }[];
    }[];
  };
  google?: {
    date: string;
    dateTo: string;
    profileViews: number;
    siteClicks: number;
    calls: number;
    directionRequests: number;
  };
}

/** Email strings for the supported languages. */
const LABELS: Record<ReportLanguage, {
  reviewsReportWord: string;
  metricsReportWord: string;
  byBranch: string;
  branch: string;
  colViews: string;
  colRoutes: string;
  colCalls: string;
  colSite: string;
  yandex: string;
  profileViews: string;
  directions: string;
  calls: string;
  site: string;
  reviewsYandex: (n: number) => string;
  reviewsGoogle: (n: number) => string;
  noReviews: string;
  generated: (dt: string) => string;
  for: (d: string) => string;
  fromTo: (a: string, b: string) => string;
}> = {
  en: {
    reviewsReportWord: 'Reviews report',
    metricsReportWord: 'Metrics report',
    byBranch: 'by branch',
    branch: 'Branch',
    colViews: 'Views',
    colRoutes: 'Routes',
    colCalls: 'Calls',
    colSite: 'Site',
    yandex: 'Yandex:',
    profileViews: 'Profile views',
    directions: 'Direction requests',
    calls: 'Call clicks',
    site: 'Website clicks',
    reviewsYandex: (n) => `New reviews — Yandex (${n})`,
    reviewsGoogle: (n) => `New reviews — Google (${n})`,
    noReviews: 'No new reviews for this period.',
    generated: (dt) => `Generated automatically: ${dt}`,
    for: (d) => `for ${d}`,
    fromTo: (a, b) => `from ${a} to ${b}`,
  },
  ru: {
    reviewsReportWord: 'Отчёт по отзывам',
    metricsReportWord: 'Отчёт по метрикам',
    byBranch: 'по филиалам',
    branch: 'Филиал',
    colViews: 'Просмотры',
    colRoutes: 'Маршруты',
    colCalls: 'Звонки',
    colSite: 'Сайт',
    yandex: 'Яндекс:',
    profileViews: 'Просмотров профиля',
    directions: 'Проложено маршрутов',
    calls: 'Нажатий «Позвонить»',
    site: 'Переходов на сайт',
    reviewsYandex: (n) => `Новые отзывы — Яндекс (${n})`,
    reviewsGoogle: (n) => `Новые отзывы — Google (${n})`,
    noReviews: 'Новых отзывов за этот период нет.',
    generated: (dt) => `Сформировано автоматически: ${dt}`,
    for: (d) => `за ${d}`,
    fromTo: (a, b) => `с ${a} по ${b}`,
  },
};

/** 2026-09-10 -> 10.09.2026 */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/** ISO string -> "10.09.2026 08:03" in the local timezone of the run */
function formatDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ratingStars(rating: number | null): string {
  if (rating === null) return '—';
  const full = '★'.repeat(Math.round(rating));
  const empty = '☆'.repeat(5 - Math.round(rating));
  return `${full}${empty} ${rating}`;
}

/** A row of metric cards (label + big number) — used by both email kinds */
function metricCardsRow(cards: [string, number][]): string {
  const card = (label: string, value: number): string => `
    <td style="padding:8px;">
      <div style="background:#f4f6fa;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:13px;color:#666;">${label}</div>
        <div style="font-size:30px;font-weight:700;color:#1a1a2e;padding-top:4px;">${value}</div>
      </div>
    </td>`;
  return `<table style="border-collapse:collapse;width:100%;"><tr>${cards.map(([lbl, v]) => card(lbl, v)).join('')}</tr></table>`;
}

/**
 * Per-branch table: the branch name column plus one column per metric.
 * Compact headers, zebra rows, names on one line — the full metric
 * labels are on the totals cards right above the table.
 */
function buildBranchTable(header: string[], rows: (string | number)[][]): string {
  const th = header
    .map((h, i) => `<th style="padding:8px 10px;background:#eef1f6;font-size:12px;font-weight:600;color:#555;text-align:${i === 0 ? 'left' : 'center'};white-space:nowrap;">${escapeHtml(h)}</th>`)
    .join('');
  const body = rows
    .map((r, ri) => `<tr${ri % 2 === 1 ? ' style="background:#f7f9fc;"' : ''}>${r
      .map((cell, i) => `<td style="padding:8px 10px;border-bottom:1px solid #e5e8ee;${i === 0 ? 'text-align:left;color:#1a1a2e;white-space:nowrap;' : 'text-align:center;color:#333;white-space:nowrap;'}">${escapeHtml(String(cell))}</td>`)
      .join('')}</tr>`)
    .join('');
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;"><tr>${th}</tr>${body}</table>`;
}

/** Period label: single day -> "for 11.09.2026", range -> "from ... to ..." */
function periodLabel(period: { date: string; dateTo?: string }, lang: ReportLanguage): string {
  const l = LABELS[lang];
  if (!period.dateTo || period.dateTo === period.date) {
    return l.for(formatDate(period.date));
  }
  return l.fromTo(formatDate(period.date), formatDate(period.dateTo));
}

/**
 * Subject: 'Report "My Chain" for 11.09.2026' — the leading word is
 * 'Report'/'Отчёт' for the full report and 'Reviews report'/'Отчёт по
 * отзывам' for a reviews-only one.
 */
function buildSubject(
  title: string,
  brand: string | undefined,
  period: { date: string; dateTo?: string },
  lang: ReportLanguage,
): string {
  // quote style by language; without a brand the quotes are dropped
  const brandQuoted = brand ? (lang === 'ru' ? `«${brand}»` : `"${brand}"`) : '';
  return brandQuoted
    ? `${title} ${brandQuoted} ${periodLabel(period, lang)}`
    : `${title} ${periodLabel(period, lang)}`;
}

/** Reviews table grouped by branch: branch header row, then one row per review */
function buildReviewsTable(
  branches: { branch: string; reviews: { author: string; rating: number | null; date: string; dateText?: string; text: string }[] }[]
): string {
  const rows: string[] = [];
  for (const branch of branches) {
    if (branch.reviews.length === 0) continue;
    rows.push(`
      <tr>
        <td colspan="2" style="background:#eef1f6;padding:10px 12px;font-weight:700;">${escapeHtml(branch.branch)}</td>
      </tr>`);
    for (const r of branch.reviews) {
      // Google dates may be approximate — prefer the original label like "a month ago"
      const date = r.dateText ?? (r.date ? formatDate(r.date.slice(0, 10)) : '');
      rows.push(`
        <tr>
          <td style="padding:10px 12px;border-bottom:1px solid #e5e8ee;vertical-align:top;white-space:nowrap;color:#555;">
            ${escapeHtml(r.author)}<br><span style="color:#f5a623;">${ratingStars(r.rating)}</span><br>
            <span style="font-size:12px;color:#999;">${escapeHtml(date)}</span>
          </td>
          <td style="padding:10px 12px;border-bottom:1px solid #e5e8ee;">${escapeHtml(r.text)}</td>
        </tr>`);
    }
  }
  return `<table style="border-collapse:collapse;width:100%;">${rows.join('')}</table>`;
}

function buildHtml(report: DailyReport, lang: ReportLanguage): string {
  const { metrika, reviews, reviewsGoogle, google } = report;
  const l = LABELS[lang];

  const cardsYandex = metricCardsRow([
    [l.profileViews, metrika.showOrg],
    [l.directions, metrika.route],
    [l.calls, metrika.call],
    [l.site, metrika.site],
  ]);

  const googleCardsHtml = google
    ? `
    <p style="margin:16px 0 6px;font-size:13px;color:#888;">Google:</p>
    ${metricCardsRow([
      [l.profileViews, google.profileViews],
      [l.directions, google.directionRequests],
      [l.calls, google.calls],
      [l.site, google.siteClicks],
    ])}`
    : '';

  const reviewsHtml =
    reviews.total === 0
      ? `<p style="color:#666;">${l.noReviews}</p>`
      : buildReviewsTable(reviews.branches);

  // Google section — only when the collection succeeded
  let googleHtml = '';
  if (reviewsGoogle) {
    const table =
      reviewsGoogle.total === 0
        ? `<p style="color:#666;">${l.noReviews}</p>`
        : buildReviewsTable(reviewsGoogle.branches);
    googleHtml = `
    <h3 style="margin:28px 0 10px;">${l.reviewsGoogle(reviewsGoogle.total)}</h3>
    ${table}`;
  }

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">
    <p style="margin:0 0 6px;font-size:13px;color:#888;">${l.yandex}</p>
    <table style="border-collapse:collapse;width:100%;"><tr>${cardsYandex}</tr></table>
    ${googleCardsHtml}
    <h3 style="margin:28px 0 10px;">${l.reviewsYandex(reviews.total)}</h3>
    ${reviewsHtml}
    ${googleHtml}
    <p style="color:#bbb;font-size:12px;margin-top:28px;">${l.generated(formatDateTimeLocal(report.generatedAt))}</p>
  </div>`;
}

/**
 * Sends the report to every recipient from MAIL_TO as a separate email
 * (each recipient sees only themselves in "To").
 * Language and brand come from the call options.
 */
export async function sendReportEmail(report: DailyReport, opts: ReportOptions = {}): Promise<void> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const subject = buildSubject(DEFAULT_BRAND[lang], opts.brand, report, lang);
  await dispatchEmail(subject, buildHtml(report, lang), opts.brand ?? DEFAULT_BRAND[lang]);
}

/** Sections of a reviews-only email: a Yandex and/or Google collection. */
export interface ReviewsEmailSections {
  reviews?: DailyReport['reviews'];
  reviewsGoogle?: DailyReport['reviewsGoogle'];
}

/** HTML of the reviews-only email: just the review sections, no metric cards. */
function buildReviewsOnlyHtml(sections: ReviewsEmailSections, lang: ReportLanguage, generatedAt: string): string {
  const l = LABELS[lang];

  const sectionHtml = (total: number, branches: NonNullable<DailyReport['reviews'] | DailyReport['reviewsGoogle']>) =>
    total === 0
      ? `<p style="color:#666;">${l.noReviews}</p>`
      : buildReviewsTable(branches.branches);

  // the first present section sits flush at the top, the next one is spaced
  const yandexHtml = sections.reviews
    ? `<h3 style="margin:0 0 10px;">${l.reviewsYandex(sections.reviews.total)}</h3>\n    ${sectionHtml(sections.reviews.total, sections.reviews)}`
    : '';
  const googleHtml = sections.reviewsGoogle
    ? `<h3 style="margin:${sections.reviews ? '28px' : '0'} 0 10px;">${l.reviewsGoogle(sections.reviewsGoogle.total)}</h3>\n    ${sectionHtml(sections.reviewsGoogle.total, sections.reviewsGoogle)}`
    : '';

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">
    ${yandexHtml}
    ${googleHtml}
    <p style="color:#bbb;font-size:12px;margin-top:28px;">${l.generated(formatDateTimeLocal(generatedAt))}</p>
  </div>`;
}

/**
 * Sends ONE reviews-only email (subject 'Reviews report ...' / 'Отчёт по
 * отзывам ...') with the Yandex and/or Google reviews together — used by
 * collectReviews with sendEmail: true.
 * The period in the subject follows the same convention as the metrika
 * range: daysBack = 1 -> "for yesterday", more -> "from ... to yesterday".
 */
export async function sendReviewsEmail(sections: ReviewsEmailSections, opts: ReportOptions = {}): Promise<void> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;

  // period bounds: from (today - daysBack) to yesterday, YYYY-MM-DD local
  const start = new Date();
  start.setDate(start.getDate() - daysBack);
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const subject = buildSubject(LABELS[lang].reviewsReportWord, opts.brand, { date: iso(start), dateTo: iso(end) }, lang);
  const html = buildReviewsOnlyHtml(sections, lang, new Date().toISOString());
  await dispatchEmail(subject, html, opts.brand ?? DEFAULT_BRAND[lang]);
}

/** Data of the metrics-only email: chain totals plus a per-branch breakdown. */
export interface MetricsEmailReport {
  date: string;
  dateTo: string;
  generatedAt: string;
  yandex: {
    route: number;
    call: number;
    site: number;
    showOrg: number;
    /** Per-branch breakdown with the same fields (optional — empty when the API gave none) */
    branches?: { branch: string; route: number; call: number; site: number; showOrg: number }[];
  };
  google?: {
    profileViews: number;
    siteClicks: number;
    calls: number;
    directionRequests: number;
    branches?: { branch: string; profileViews: number; siteClicks: number; calls: number; directionRequests: number }[];
  } | null;
}

/** HTML of the metrics-only email: per service — totals cards + the per-branch table; no reviews. */
function buildMetricsHtml(report: MetricsEmailReport, lang: ReportLanguage): string {
  const l = LABELS[lang];
  const yName = lang === 'ru' ? 'Яндекс' : 'Yandex';
  const cols = [l.branch, l.colViews, l.colRoutes, l.colCalls, l.colSite];

  // one service block: header, totals cards, then its per-branch table
  const section = (name: string, first: boolean, cards: string, tableRows: (string | number)[][]): string => {
    const table = tableRows.length > 0
      ? `<p style="margin:16px 0 8px;font-size:13px;color:#888;">${l.byBranch}</p>\n    ${buildBranchTable(cols, tableRows)}`
      : '';
    return `
    <h2 style="margin:${first ? 0 : '32px'} 0 10px;font-size:16px;border-bottom:2px solid #e5e8ee;padding-bottom:6px;">${name}</h2>
    ${cards}
    ${table}`;
  };

  const yandexSection = section(yName, true,
    metricCardsRow([
      [l.profileViews, report.yandex.showOrg],
      [l.directions, report.yandex.route],
      [l.calls, report.yandex.call],
      [l.site, report.yandex.site],
    ]),
    (report.yandex.branches ?? []).map((b) => [b.branch, b.showOrg, b.route, b.call, b.site]),
  );

  const googleSection = report.google
    ? section('Google', false,
        metricCardsRow([
          [l.profileViews, report.google.profileViews],
          [l.directions, report.google.directionRequests],
          [l.calls, report.google.calls],
          [l.site, report.google.siteClicks],
        ]),
        (report.google.branches ?? []).map((b) => [b.branch, b.profileViews, b.directionRequests, b.calls, b.siteClicks]),
      )
    : '';

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a2e;">${yandexSection}${googleSection}
    <p style="color:#bbb;font-size:12px;margin-top:28px;">${l.generated(formatDateTimeLocal(report.generatedAt))}</p>
  </div>`;
}

/**
 * Sends the metrics-only email (subject 'Metrics report ...' / 'Отчёт по
 * метрикам ...') — chain totals as cards plus the per-branch tables, no
 * reviews. Used by collectMetrics with sendEmail: true.
 */
export async function sendMetricsEmail(report: MetricsEmailReport, opts: ReportOptions = {}): Promise<void> {
  const lang = opts.lang ?? DEFAULT_LANG;
  const subject = buildSubject(LABELS[lang].metricsReportWord, opts.brand, report, lang);
  await dispatchEmail(subject, buildMetricsHtml(report, lang), opts.brand ?? DEFAULT_BRAND[lang]);
}

/**
 * Shared delivery of both report kinds: a separate email per recipient
 * (each one sees only themselves in "To"). Skipped with a warning when
 * mail is not configured — collection is not considered failed.
 */
async function dispatchEmail(subject: string, html: string, brand: string): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_TO } = process.env;

  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !MAIL_TO) {
    console.warn('Mail is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_TO in .env) — email skipped');
    return;
  }

  // multiple recipients allowed, comma-separated: a@mail.com, b@gmail.com
  const recipients = MAIL_TO.split(',').map((s) => s.trim()).filter(Boolean);

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT ?? 465),
    secure: Number(SMTP_PORT ?? 465) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const sent: string[] = [];
  const failed: string[] = [];

  // one separate email per recipient: each one sees only themselves in "To"
  for (const to of recipients) {
    try {
      await transporter.sendMail({ from: `"${brand}" <${SMTP_USER}>`, to, subject, html });
      sent.push(to);
    } catch (e) {
      failed.push(`${to}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (sent.length > 0) console.log(`Report email sent to: ${sent.join(', ')}`);
  if (failed.length > 0) {
    console.error('Failed to deliver:');
    for (const f of failed) console.error(`   ${f}`);
    process.exitCode = 1;
  }
}

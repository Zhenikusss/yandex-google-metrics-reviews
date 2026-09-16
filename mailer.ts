/**
 * Sends the report as an HTML email.
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
import { DEFAULT_LANG, DEFAULT_BRAND } from './options.js';

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
  subtitle: string;
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
    subtitle: 'Yandex Business stats + new reviews from Yandex Maps and Google Maps',
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
    subtitle: 'Статистика Яндекс.Бизнес + новые отзывы с Яндекс.Карт и Google Maps',
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

/** Period label: single day -> "for 11.09.2026", range -> "from ... to ..." */
function periodLabel(report: DailyReport, lang: ReportLanguage): string {
  const l = LABELS[lang];
  if (!report.dateTo || report.dateTo === report.date) {
    return l.for(formatDate(report.date));
  }
  return l.fromTo(formatDate(report.date), formatDate(report.dateTo));
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

  const card = (label: string, value: number): string => `
    <td style="padding:8px;">
      <div style="background:#f4f6fa;border-radius:10px;padding:16px;text-align:center;">
        <div style="font-size:13px;color:#666;">${label}</div>
        <div style="font-size:30px;font-weight:700;color:#1a1a2e;padding-top:4px;">${value}</div>
      </div>
    </td>`;

  const cardsYandex = ([
    [l.profileViews, metrika.showOrg],
    [l.directions, metrika.route],
    [l.calls, metrika.call],
    [l.site, metrika.site],
  ] as [string, number][]).map(([lbl, v]) => card(lbl, v)).join('');

  const googleCardsHtml = google
    ? `
    <p style="margin:16px 0 6px;font-size:13px;color:#888;">Google:</p>
    <table style="border-collapse:collapse;width:100%;"><tr>${(
      [
        [l.profileViews, google.profileViews],
        [l.directions, google.directionRequests],
        [l.calls, google.calls],
        [l.site, google.siteClicks],
      ] as [string, number][]
    ).map(([lbl, v]) => card(lbl, v)).join('')}</tr></table>`
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
    <p style="color:#888;margin:0 0 6px;font-size:13px;">${l.subtitle}</p>
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

  const lang = opts.lang ?? DEFAULT_LANG;
  const reportWord = DEFAULT_BRAND[lang]; // the localized "Report" word
  const brand = opts.brand ?? reportWord;
  // subject: 'Report "My Chain" for ...' (quote style by language);
  // the sender name stays just the brand, without the word
  const brandQuoted = opts.brand
    ? (lang === 'ru' ? `«${opts.brand}»` : `"${opts.brand}"`)
    : '';
  const subject = brandQuoted
    ? `${reportWord} ${brandQuoted} ${periodLabel(report, lang)}`
    : `${reportWord} ${periodLabel(report, lang)}`;
  const html = buildHtml(report, lang);
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

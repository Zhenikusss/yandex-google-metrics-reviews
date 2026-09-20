/** Shared options for all package functions. */

export type ReportLanguage = 'ru' | 'en';

export interface ReportOptions {
  /**
   * How many days back to collect data: 1 = yesterday.
   * Applies to all sources: the Metrika range, the reviews period
   * and the email subject.
   */
  daysBack?: number | undefined;

  /**
   * Brand name: the email sender name; in the subject it goes in
   * quotes after the localized "Report" word — 'Report "My Chain" for ...'.
   * Defaults to that word itself when no brand is given.
   */
  brand?: string | undefined;

  /** Report language: 'ru' or 'en' (default 'en'). */
  lang?: ReportLanguage | undefined;
}

export interface ReviewsOptions extends ReportOptions {
  /**
   * collectReviews only: after collecting both platforms send ONE
   * reviews-only email with the Yandex and Google reviews together
   * (default false — collect only, no email). Recipients and SMTP
   * come from .env, the language and brand from the sibling options.
   */
  sendEmail?: boolean | undefined;
}

/**
 * The metrics period of collectMetrics: a number of days back — that
 * many days ending yesterday (7 = yesterday-6 .. yesterday); 'week' —
 * a readable alias of the same trailing 7 days ending yesterday (run on
 * a Thursday -> the previous Thursday..Wednesday); 'month' — the whole
 * PREVIOUS calendar month (any September run covers 01..31 August).
 */
export type MetricsPeriod = number | 'week' | 'month';

export interface MetricsOptions extends Omit<ReportOptions, 'daysBack'> {
  /**
   * The collection period: a number of days (default 1 — yesterday),
   * 'week' or 'month' — see MetricsPeriod.
   */
  daysBack?: MetricsPeriod | undefined;

  /**
   * collectMetrics: send ONE metrics-only email after collecting —
   * chain totals + per-branch tables, no reviews
   * (default false — collect only, no email). Recipients and SMTP
   * come from .env, the language and brand from the sibling options.
   */
  sendEmail?: boolean | undefined;

  /**
   * Explicit period, YYYY-MM-DD (inclusive). When both dateFrom and
   * dateTo are set they override daysBack — for any exact custom period.
   */
  dateFrom?: string | undefined;

  /** Explicit period end, YYYY-MM-DD (inclusive). */
  dateTo?: string | undefined;
}

/** Default value: a yesterday report. */
export const DEFAULT_DAYS_BACK = 1;

/** Default report language. */
export const DEFAULT_LANG: ReportLanguage = 'en';

/** Default email brand, by language. */
export const DEFAULT_BRAND: Record<ReportLanguage, string> = {
  en: 'Report',
  ru: 'Отчёт',
};

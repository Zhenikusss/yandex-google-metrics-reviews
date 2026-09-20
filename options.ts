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

/** Default value: a yesterday report. */
export const DEFAULT_DAYS_BACK = 1;

/** Default report language. */
export const DEFAULT_LANG: ReportLanguage = 'en';

/** Default email brand, by language. */
export const DEFAULT_BRAND: Record<ReportLanguage, string> = {
  en: 'Report',
  ru: 'Отчёт',
};

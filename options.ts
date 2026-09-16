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
   * Brand name used in the email subject and sender name
   * (defaults to "Report" / «Отчёт» depending on the language).
   */
  brand?: string | undefined;

  /** Report language: 'ru' or 'en' (default 'en'). */
  lang?: ReportLanguage | undefined;
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

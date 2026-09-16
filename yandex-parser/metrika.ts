/**
* Yandex Metrika stats (Yandex Business landing events): routes, calls,
* website clicks and profile shows for the daysBack period
* (yesterday by default).
*/

import axios from 'axios';
import * as dotenv from 'dotenv';
import { DEFAULT_DAYS_BACK } from '../options.js';
import type { ReportOptions } from '../options.js';

dotenv.config({ quiet: true });

const YANDEX_TOKEN: string | undefined = process.env.YANDEX_METRIKA_TOKEN;
const YANDEX_COUNTER_ID: string | undefined = process.env.YANDEX_COUNTER_ID;

interface MetrikaParams {
  id: string;
  metrics: string;
  dimensions: string;
  date1: string;
  date2: string;
  accuracy: string;
  [key: string]: string;
}

export interface MetrikaDaily {
  date: string;   // first day of the period
  dateTo: string; // last day of the period (equals date for a single-day report)
  route: number;   // direction requests
  call: number;    // call clicks
  site: number;    // website clicks
  showOrg: number; // profile shows (show-org + show_org)
  events: Record<string, number>; // all events as returned by Metrika
}

/**
 * Formats a date as YYYY-MM-DD in LOCAL time.
 * toISOString() must not be used here: it returns UTC, and right after
 * midnight "yesterday" would shift back a day.
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Report range: from (yesterday - daysBack + 1) to yesterday.
 * daysBack = 1 -> yesterday only, 7 -> the last 7 days.
 */
function getReportDateRange(daysBack: number): { start: string; end: string } {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const start = new Date(yesterday);
  start.setDate(start.getDate() - (daysBack - 1));

  return { start: formatDate(start), end: formatDate(yesterday) };
}

/**
 * Flattens the Metrika response into per-event counters.
 * Profile shows are the sum of two events: show-org and show_org.
 */
function normalizeMetrika(raw: any, date: string, dateTo: string): MetrikaDaily {
  const events: Record<string, number> = {};
  for (const row of raw?.data ?? []) {
    const id: string | undefined = row?.dimensions?.[0]?.id;
    const value = Number(row?.metrics?.[0] ?? 0);
    if (id) events[id] = (events[id] ?? 0) + value;
  }
  return {
    date,
    dateTo,
    route: events['route'] ?? 0,
    call: events['call'] ?? 0,
    site: events['site'] ?? 0,
    showOrg: (events['show-org'] ?? 0) + (events['show_org'] ?? 0),
    events,
  };
}

/** Collects and normalizes Yandex Metrika data for the period. */
export async function getYandexStats(opts: ReportOptions = {}): Promise<MetrikaDaily> {
  if (!YANDEX_TOKEN || !YANDEX_COUNTER_ID) {
    throw new Error('YANDEX_METRIKA_TOKEN and/or YANDEX_COUNTER_ID are not set (.env)');
  }

  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const { start, end } = getReportDateRange(daysBack);

  const params: MetrikaParams = {
    id: YANDEX_COUNTER_ID,
    metrics: 'ym:s:vacuumevents',
    dimensions: 'ym:s:vacuumEvent',
    date1: start,
    date2: end,
    accuracy: 'full',
  };

  console.log(`Requesting Yandex Metrika for ${start}..${end}...`);

  try {
    const response = await axios.get('https://api-metrika.yandex.net/stat/v1/data', {
      params,
      headers: {
        'Authorization': `OAuth ${YANDEX_TOKEN}`,
        'Accept': 'application/json',
      },
      timeout: 30000,
    });

    console.log('Yandex data received');

    return normalizeMetrika(response.data, start, end);
  } catch (error: any) {
    console.error('Failed to fetch Yandex data:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.error(error.message);
    }
    throw error;
  }
}

// direct run — a test pass that writes no files
const { pathToFileURL } = await import('url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stats = await getYandexStats();
    console.log('Result:', JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

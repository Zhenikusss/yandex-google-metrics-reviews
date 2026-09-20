/**
* Yandex Metrika stats (Yandex Business landing events): routes, calls,
* website clicks and profile shows for the daysBack period
* (yesterday by default) — TOTALS plus a per-branch breakdown
* (the ym:s:vacuumOrganization dimension of the same events).
*/

import axios from 'axios';
import * as dotenv from 'dotenv';
import { DEFAULT_DAYS_BACK } from '../options.js';
import type { MetricsOptions } from '../options.js';
import { loadBranchAliases, cleanYandexOrgName } from '../branches.js';

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

/** One chain branch: the same fields as the chain totals. */
export interface YandexBranchMetrics {
  branch: string;
  orgId: string;
  route: number;    // direction requests
  call: number;     // call clicks
  site: number;     // website clicks
  showOrg: number;  // profile shows
}

export interface MetrikaDaily {
  date: string;   // first day of the period
  dateTo: string; // last day of the period (equals date for a single-day report)
  route: number;   // direction requests
  call: number;    // call clicks
  site: number;    // website clicks
  showOrg: number; // profile shows (show-org + show_org)
  events: Record<string, number>; // all events as returned by Metrika
  /** Per-branch breakdown of the same fields (most active first) */
  branches: YandexBranchMetrics[];
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
 * An explicit dateFrom/dateTo pair overrides daysBack (the 'month' period
 * of collectMetrics and custom periods).
 */
function getReportDateRange(daysBack: number, dateFrom?: string, dateTo?: string): { start: string; end: string } {
  if (dateFrom && dateTo) return { start: dateFrom, end: dateTo };

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  const start = new Date(yesterday);
  start.setDate(start.getDate() - (daysBack - 1));

  return { start: formatDate(start), end: formatDate(yesterday) };
}

/** showOrg is the sum of two spellings of the same event */
function profileShows(events: Record<string, number>): number {
  return (events['show-org'] ?? 0) + (events['show_org'] ?? 0);
}

/**
 * Flattens the Metrika response into per-event totals AND a per-branch
 * breakdown. Rows come as (event, organization) pairs; rows without an
 * organization are counted into the totals only.
 */
function normalizeMetrika(raw: any, date: string, dateTo: string): MetrikaDaily {
  const totals: Record<string, number> = {};
  const byOrg = new Map<string, { name: string; events: Record<string, number> }>();

  for (const row of raw?.data ?? []) {
    const event: string | undefined = row?.dimensions?.[0]?.id;
    if (!event) continue;
    const value = Number(row?.metrics?.[0] ?? 0);
    totals[event] = (totals[event] ?? 0) + value;

    const org = row?.dimensions?.[1]; // { id, name } of ym:s:vacuumOrganization
    if (org?.id) {
      const bucket = byOrg.get(org.id) ?? { name: org.name ?? org.id, events: {} as Record<string, number> };
      bucket.events[event] = (bucket.events[event] ?? 0) + value;
      byOrg.set(org.id, bucket);
    }
  }

  const aliases = loadBranchAliases();
  const branches = [...byOrg.entries()]
    .map(([orgId, b]) => ({
      branch: cleanYandexOrgName(b.name, aliases),
      orgId,
      route: b.events['route'] ?? 0,
      call: b.events['call'] ?? 0,
      site: b.events['site'] ?? 0,
      showOrg: profileShows(b.events),
    }))
    .sort((a, b) => b.showOrg - a.showOrg);

  return {
    date,
    dateTo,
    route: totals['route'] ?? 0,
    call: totals['call'] ?? 0,
    site: totals['site'] ?? 0,
    showOrg: profileShows(totals),
    events: totals,
    branches,
  };
}

/** Collects and normalizes Yandex Metrika data for the period. */
export async function getYandexStats(opts: MetricsOptions = {}): Promise<MetrikaDaily> {
  if (!YANDEX_TOKEN || !YANDEX_COUNTER_ID) {
    throw new Error('YANDEX_METRIKA_TOKEN and/or YANDEX_COUNTER_ID are not set (.env)');
  }

  // 'week'/'month' are collectMetrics keywords — here they arrive only
  // together with the resolved dateFrom/dateTo; a bare keyword is a mistake
  if (typeof opts.daysBack === 'string' && !opts.dateFrom && !opts.dateTo) {
    throw new Error(`daysBack: '${opts.daysBack}' is a collectMetrics keyword — pass a number of days or dateFrom/dateTo`);
  }
  const daysBack = typeof opts.daysBack === 'number' ? opts.daysBack : DEFAULT_DAYS_BACK;
  const { start, end } = getReportDateRange(daysBack, opts.dateFrom, opts.dateTo);

  const params: MetrikaParams = {
    id: YANDEX_COUNTER_ID,
    metrics: 'ym:s:vacuumevents',
    // the second dimension splits the events by chain branch
    dimensions: 'ym:s:vacuumEvent,ym:s:vacuumOrganization',
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

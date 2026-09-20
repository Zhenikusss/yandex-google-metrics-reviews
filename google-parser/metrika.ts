/**
* Google Business Profile stats (Performance API) for the daysBack period
* (yesterday by default) — TOTALS plus a per-branch breakdown across all
* locations of the business account: website clicks, calls, direction
* requests and profile views.
*
* How it works: exchange the refresh token for an access token ->
* list all account locations -> fetch metrics per location -> sum the
* totals and keep each location's row for the per-branch table.
*
* Auth comes from environment variables only (.env):
*   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — OAuth client from Google Cloud Console
*   GOOGLE_REFRESH_TOKEN                     — long-lived refresh token
*/

import * as dotenv from 'dotenv';
import { DEFAULT_DAYS_BACK } from '../options.js';
import type { ReportOptions } from '../options.js';
import { loadBranchAliases, normalizeBranchName } from '../branches.js';
import { getGoogleAccessToken, listGoogleLocations } from './auth.js';
import type { GoogleLocation } from './auth.js';

dotenv.config({ quiet: true });

/** One location: the same fields as the account totals. */
export interface GoogleBranchMetrics {
  branch: string;
  profileViews: number;
  siteClicks: number;
  calls: number;
  directionRequests: number;
}

export interface GoogleStats {
  date: string;              // first day of the period
  dateTo: string;            // last day of the period
  locationsCount: number;    // how many locations are summed
  profileViews: number;      // profile views (sum of BUSINESS_IMPRESSIONS_*)
  siteClicks: number;        // WEBSITE_CLICKS (sum)
  calls: number;             // CALL_CLICKS (sum)
  directionRequests: number; // BUSINESS_DIRECTION_REQUESTS (sum)
  /** Per-branch breakdown of the same fields (most active first) */
  branches: GoogleBranchMetrics[];
}

/** YYYY-MM-DD in local time */
function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Range like in Metrika: from (yesterday - daysBack + 1) to yesterday */
function getReportDateRange(daysBack: number): { start: Date; end: Date } {
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (daysBack - 1));
  return { start, end };
}

/** Metrics of one location for the period (days without a value = zero activity) */
async function fetchLocationStats(
  accessToken: string,
  locationId: string,
  start: Date,
  end: Date
): Promise<{ profileViews: number; siteClicks: number; calls: number; directionRequests: number }> {
  const params = new URLSearchParams();
  // "Company profile views" in the dashboard = the sum of the four impression
  // metrics (Search/Maps x desktop/mobile)
  params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_DESKTOP_MAPS');
  params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH');
  params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_MOBILE_MAPS');
  params.append('dailyMetrics', 'BUSINESS_IMPRESSIONS_MOBILE_SEARCH');
  params.append('dailyMetrics', 'WEBSITE_CLICKS');
  params.append('dailyMetrics', 'CALL_CLICKS');
  params.append('dailyMetrics', 'BUSINESS_DIRECTION_REQUESTS');
  params.append('dailyRange.start_date.year', String(start.getFullYear()));
  params.append('dailyRange.start_date.month', String(start.getMonth() + 1));
  params.append('dailyRange.start_date.day', String(start.getDate()));
  params.append('dailyRange.end_date.year', String(end.getFullYear()));
  params.append('dailyRange.end_date.month', String(end.getMonth() + 1));
  params.append('dailyRange.end_date.day', String(end.getDate()));

  const url =
    `https://businessprofileperformance.googleapis.com/v1/locations/${locationId}` +
    `:fetchMultiDailyMetricsTimeSeries?${params.toString()}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Google API HTTP ${response.status} (location ${locationId}): ${(await response.text()).slice(0, 300)}`);
  }

  const data = await response.json();
  // response: multiDailyMetricTimeSeries[0].dailyMetricTimeSeries[] ->
  //   { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [{ date: {...}, value: '14' }, ...] } }
  const series = data?.multiDailyMetricTimeSeries?.[0]?.dailyMetricTimeSeries ?? [];

  const stats = { profileViews: 0, siteClicks: 0, calls: 0, directionRequests: 0 };
  for (const s of series) {
    let sum = 0;
    for (const dv of s?.timeSeries?.datedValues ?? []) {
      if (dv?.value !== undefined && dv?.value !== null) sum += Number(dv.value) || 0;
    }
    if (s.dailyMetric?.startsWith('BUSINESS_IMPRESSIONS_')) stats.profileViews += sum;
    else if (s.dailyMetric === 'WEBSITE_CLICKS') stats.siteClicks = sum;
    else if (s.dailyMetric === 'CALL_CLICKS') stats.calls = sum;
    else if (s.dailyMetric === 'BUSINESS_DIRECTION_REQUESTS') stats.directionRequests = sum;
  }
  return stats;
}

/**
 * Stats across ALL business account locations for the period: totals plus
 * a per-branch breakdown.
 * IMPORTANT: valid metric names of this API:
 *   WEBSITE_CLICKS, CALL_CLICKS, BUSINESS_DIRECTION_REQUESTS,
 *   BUSINESS_IMPRESSIONS_{DESKTOP,MOBILE}_{MAPS,SEARCH}
 *   (DIRECTION_REQUESTS does not exist — a 400 INVALID_ARGUMENT follows)
 */
export async function getGoogleStats(opts: ReportOptions = {}): Promise<GoogleStats> {
  const accessToken = await getGoogleAccessToken();
  const locations: GoogleLocation[] = await listGoogleLocations(accessToken);
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const { start, end } = getReportDateRange(daysBack);

  console.log(`[Google] Metrics for ${fmt(start)}..${fmt(end)} across ${locations.length} locations...`);

  const totals: GoogleStats = {
    date: fmt(start),
    dateTo: fmt(end),
    locationsCount: locations.length,
    profileViews: 0,
    siteClicks: 0,
    calls: 0,
    directionRequests: 0,
    branches: [],
  };

  const aliases = loadBranchAliases();
  for (const loc of locations) {
    const s = await fetchLocationStats(accessToken, loc.id, start, end);
    totals.profileViews += s.profileViews;
    totals.siteClicks += s.siteClicks;
    totals.calls += s.calls;
    totals.directionRequests += s.directionRequests;
    totals.branches.push({
      branch: normalizeBranchName(loc.address, loc.title, aliases),
      profileViews: s.profileViews,
      siteClicks: s.siteClicks,
      calls: s.calls,
      directionRequests: s.directionRequests,
    });
  }
  totals.branches.sort((a, b) => b.profileViews - a.profileViews);

  console.log(`[Google] Summed across ${totals.locationsCount} locations: profile=${totals.profileViews}, site=${totals.siteClicks}, calls=${totals.calls}, directions=${totals.directionRequests}`);
  return totals;
}

// direct run — a test pass that writes no files
const { pathToFileURL } = await import('url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const stats = await getGoogleStats();
    console.log('Result:', JSON.stringify(stats, null, 2));
  } catch (e) {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

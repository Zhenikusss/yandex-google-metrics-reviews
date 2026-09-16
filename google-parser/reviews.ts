/**
* Google reviews (author, rating, text, EXACT date) for the daysBack period
* (yesterday by default) across all business account locations — through the
* OFFICIAL Business Profile API, no browser and no scraping.
*
* The location list is live (see auth.ts): a newly shared location's
* reviews show up in the report automatically.
*/

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { DEFAULT_DAYS_BACK } from '../options.js';
import type { ReportOptions } from '../options.js';
import { getGoogleAccessToken, listGoogleLocations } from './auth.js';

dotenv.config({ quiet: true });

/**
 * Google address -> canonical branch name mapping.
 * Read from branches.json in the USER'S CURRENT directory (key — a
 * substring of the Google address, value — the name in the report).
 * No file or no match — the address is simply cleaned
 * (street with house number, no city or postal code).
 */
function loadBranchAliases(): Record<string, string> {
  const file = path.join(process.cwd(), 'branches.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  } catch {
    console.warn('[Google] branches.json not found or invalid — branches will use auto names');
    return {};
  }
}

export interface ReviewRow {
  author: string;
  rating: number | null;
  date: string; // exact review creation time (ISO, from the API)
  text: string;
}

export interface GoogleBranchResult {
  branch: string;
  reviewsCount: number;
  reviews: ReviewRow[];
}

export interface GoogleReviewsCollection {
  total: number;
  branches: GoogleBranchResult[];
  failures: string[];
}

/** "FIVE"/"THREE" -> 5/3 */
const STAR_MAP: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

/** Google address -> branch name (branches.json, fallback — cleaned address) */
function normalizeBranchName(address: string | null, fallback: string, aliases: Record<string, string>): string {
  if (!address) return fallback;
  const cleaned = address.replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, '').trim();
  for (const [key, alias] of Object.entries(aliases)) {
    if (cleaned.includes(key)) return alias;
  }
  return cleaned.split(',')[0]?.trim() || fallback;
}

/** Start of the day daysBack days ago — the lower bound of the reviews period */
function getCutoffDate(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Reviews for several locations at once — batchGetReviews (My Business API
 * v4, host mybusiness.googleapis.com; Business Information has no reviews —
 * a 404 follows).
 * Response: { locationReviews: [ { name: "accounts/X/locations/Y", review: {...} } ] }
 */
async function fetchReviewsBatch(
  accessToken: string,
  accountPath: string, // accounts/XXX
  locationPaths: string[]
): Promise<RawReview[]> {
  const all: RawReview[] = [];
  let pageToken: string | undefined;

  do {
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${accountPath}/locations:batchGetReviews`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        locationNames: locationPaths,
        ...(pageToken ? { pageToken } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const page: {
      locationReviews?: { name?: string; review?: RawReview }[];
      nextPageToken?: string;
    } = await res.json();

    for (const lr of page.locationReviews ?? []) {
      if (!lr.review) continue;
      // the location path comes from the wrapper, fallback — from the review name
      lr.review.locationPath = lr.name ?? (lr.review.name ? locationPathOfReview(lr.review.name) : undefined) ?? undefined;
      all.push(lr.review);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);

  return all;
}

/** Extracts the location path from a review name (accounts/X/locations/Y/reviews/Z) */
function locationPathOfReview(reviewName: string): string | null {
  const m = reviewName.match(/^(accounts\/[^/]+\/locations\/[^/]+)\/reviews\//);
  return m?.[1] ?? null;
}

/**
 * Google wraps the text with an autotranslation: "(Translated by Google) ...
 * (Original)\n...". We take the original as the author wrote it; without
 * the wrapper the text is used as is.
 */
function cleanComment(text: string): string {
  const idx = text.indexOf('(Original)');
  if (idx !== -1) return text.slice(idx + '(Original)'.length).trim();
  return text.trim();
}

interface RawReview {
  name?: string; // accounts/X/locations/Y/reviews/Z
  locationPath?: string | undefined; // accounts/X/locations/Y (from the batch wrapper)
  reviewer?: { displayName?: string };
  starRating?: string; // ONE..FIVE
  createTime?: string; // exact ISO
  comment?: string; // review text
}

/**
 * Reviews for the daysBack period (yesterday by default) across all
 * business account locations.
 */
export async function collectGoogleReviews(opts: ReportOptions = {}): Promise<GoogleReviewsCollection> {
  const accessToken = await getGoogleAccessToken();
  const locations = await listGoogleLocations(accessToken);
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const cutoff = getCutoffDate(daysBack);

  console.log(`[Google] Locations in the account: ${locations.length}, reviews since ${cutoff.toISOString().slice(0, 10)}...`);

  // group locations by account: batchGetReviews works at the account level
  const aliases = loadBranchAliases();
  const byAccount = new Map<string, { locPath: string; branch: string }[]>();
  for (const loc of locations) {
    const acc = loc.path.match(/^(accounts\/[^/]+)\//)?.[1];
    if (!acc) {
      console.warn(`[Google] Cannot parse the location path: ${loc.path}`);
      continue;
    }
    if (!byAccount.has(acc)) byAccount.set(acc, []);
    byAccount.get(acc)!.push({
      locPath: loc.path,
      branch: normalizeBranchName(loc.address, loc.title, aliases),
    });
  }

  // location path -> branch result bucket
  const resultsByPath = new Map<string, GoogleBranchResult>();
  for (const group of byAccount.values()) {
    for (const g of group) {
      resultsByPath.set(g.locPath, { branch: g.branch, reviewsCount: 0, reviews: [] });
    }
  }

  const failures: string[] = [];

  for (const [accountPath, group] of byAccount) {
    try {
      const raw = await fetchReviewsBatch(
        accessToken,
        accountPath,
        group.map((g) => g.locPath)
      );
      for (const r of raw) {
        const bucket = r.locationPath ? resultsByPath.get(r.locationPath) : undefined;
        if (!bucket) continue;
        if (!r.createTime || new Date(r.createTime) < cutoff) continue;
        bucket.reviews.push({
          author: r.reviewer?.displayName?.trim() || 'Anonymous',
          rating: r.starRating ? STAR_MAP[r.starRating] ?? null : null,
          date: r.createTime,
          text: cleanComment(r.comment ?? ''),
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`account ${accountPath}: ${msg}`);
      console.error(`[Google] Reviews of the account not collected: ${msg}`);
    }
  }

  // newest first + counters
  const results = [...resultsByPath.values()];
  for (const r of results) {
    r.reviews.sort((a, b) => b.date.localeCompare(a.date));
    r.reviewsCount = r.reviews.length;
    console.log(`[Google]   ${r.branch}: ${r.reviewsCount}`);
  }

  const total = results.reduce((sum, b) => sum + b.reviewsCount, 0);
  return { total, branches: results, failures };
}

// direct run — a test pass that writes no files
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { total, branches, failures } = await collectGoogleReviews();
  console.log(`\nDone: ${total} reviews across ${branches.length} locations`);
  for (const b of branches) {
    console.log(`   - ${b.branch}: ${b.reviewsCount}`);
  }
  for (const f of failures) console.log(`   x ${f}`);
}

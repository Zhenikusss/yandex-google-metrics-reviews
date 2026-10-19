/**
* Collects reviews (author, rating, text, date) for the last daysBack days
* across all branches of a chain on Yandex Maps. Used from index.ts (the
* result goes into the reports); a direct run (npx tsx yandex-parser/reviews.ts)
* prints a summary to the console.
*
* Single path, no browser, no captcha: the same internal API the maps web
* app itself uses — GET /maps/api/business/fetchReviews with
* ranking=by_time (true newest-first) and pagination. The request signature
* (s = djb2-xor of the qs-serialized, case-insensitively sorted query) and
* the session ingredients (page cookies, csrfToken, sessionId) are
* replicated from the maps JS bundle. Unofficial: if Yandex changes the
* algorithm, this starts failing loudly (per-branch errors in the logs).
*
* The branch list: YANDEX_BRANCHES ("orgId:name;orgId:name;...") is the
* source of truth; the chain page SSR (YANDEX_CHAIN_URL) adds unknown ids
* automatically (it only shows its first screen of cards).
*/

import * as path from 'path';
import { pathToFileURL } from 'url';
import * as dotenv from 'dotenv';
import { DEFAULT_DAYS_BACK } from '../options.js';
import type { ReportOptions } from '../options.js';

dotenv.config({ quiet: true });

interface Branch {
  name: string;
  orgId: string;
}

// chain page on Yandex Maps — freshness check for the branch list (.env)
const CHAIN_URL = process.env.YANDEX_CHAIN_URL;

// Yandex Maps origin — derived from the chain URL, so the requests
// match the user's domain (yandex.by / yandex.ru / yandex.kz ...)
const MAPS_ORIGIN = CHAIN_URL ? new URL(CHAIN_URL).origin : 'https://yandex.by';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface Review {
  author: string;
  date: Date | null;
  rating: number | null;
  text: string;
}

interface ReviewRow {
  author: string;
  rating: number | null;
  date: string;
  text: string;
}

export interface BranchResult {
  branch: string;
  orgId: string;
  reviewsCount: number;
  reviews: ReviewRow[];
}

export interface ReviewsCollection {
  total: number;
  branches: BranchResult[];
  /** Branches that could not be collected — for logs */
  failures: string[];
}

function getCutoffDate(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  // count from the start of the day: a run at 8am on the 11th
  // collects reviews since 00:00 on the 10th
  d.setHours(0, 0, 0, 0);
  return d;
}

// ---- the maps API request signing (replicated from the maps JS bundle) ----

function signDjb2(str: string): string {
  let n = 5381;
  for (let i = 0; i < str.length; i++) n = (33 * n) ^ str.charCodeAt(i);
  return String(n >>> 0);
}

/** qs-style serialization: keys sorted case-insensitively, encodeURIComponent values. */
function qsSorted(params: Record<string, string>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .sort(([a], [b]) => {
      const la = a.toLowerCase();
      const lb = b.toLowerCase();
      return la < lb ? -1 : la > lb ? 1 : 0;
    })
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
}

function looksLikeCaptchaHtml(html: string): boolean {
  return html.includes('Подтвердите, что запросы') || html.includes('showcaptcha');
}

interface ApiReview {
  author?: { name?: string };
  text?: string;
  rating?: number | string;
  updatedTime?: string;
  createdTime?: string;
}

/**
 * Reviews of one branch: pages of 50, newest first, until older than the
 * cutoff. The org page provides the session ingredients (cookies,
 * csrfToken, sessionId); a csrf-refresh response is retried with the
 * fresh token, exactly like the web app does.
 */
async function fetchBranchReviews(branch: Branch, cutoff: Date): Promise<Review[]> {
  const pageRes = await fetch(`${MAPS_ORIGIN}/maps/org/${branch.orgId}/reviews/`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });
  if (!pageRes.ok) throw new Error(`org page HTTP ${pageRes.status}`);
  const jar: Record<string, string> = {};
  for (const c of pageRes.headers.getSetCookie?.() ?? []) {
    const kv = c.split(';')[0];
    if (!kv) continue;
    const eq = kv.indexOf('=');
    if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1).trim();
  }
  const cookieHeader = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const html = await pageRes.text();
  if (looksLikeCaptchaHtml(html)) throw new Error('Yandex served a captcha page');
  const pageCsrf = html.match(/csrfToken["']?\s*[:=]\s*["']([a-z0-9:_-]+)/i)?.[1];
  if (!pageCsrf) throw new Error('no csrfToken in the org page');
  const sessionId = html.match(/["']sessionId["']\s*:\s*["']([^"']+)["']/)?.[1]
    ?? `${Date.now()}${Math.floor(100 + Math.random() * 899)}-${String(Math.floor(Math.random() * 1e19))}-${Math.random().toString(36).slice(2, 18)}-BAL`;
  const reqId = `${Date.now()}${Math.floor(100 + Math.random() * 899)}-${Math.floor(Math.random() * 1e10)}-addrs-upper-yp-152`;

  const collected: Review[] = [];
  let total: string | number = '?';
  let csrf = pageCsrf;
  for (let pageNo = 1; pageNo <= 30; pageNo++) {
    let list: ApiReview[] = [];
    for (let round = 1; round <= 3; round++) {
      const params: Record<string, string> = {
        ajax: '1',
        businessId: branch.orgId,
        csrfToken: csrf,
        locale: 'ru_UA',
        page: String(pageNo),
        pageSize: '50',
        ranking: 'by_time',
        reqId,
        sessionId,
      };
      const serialized = qsSorted(params);
      const url = `${MAPS_ORIGIN}/maps/api/business/fetchReviews?${serialized}&s=${signDjb2(serialized)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': BROWSER_UA,
          'Referer': `${MAPS_ORIGIN}/maps/org/${branch.orgId}/reviews/`,
          'X-Requested-With': 'XMLHttpRequest',
          'Cookie': cookieHeader,
        },
      });
      const text = await res.text();
      // the server may respond with a fresh csrf token — retry the page with it
      const fresh = text.match(/"csrfToken":"([^"]+)"/)?.[1];
      if (fresh && text.length < 200) {
        csrf = fresh;
        continue;
      }
      if (!res.ok) throw new Error(`API HTTP ${res.status}`);
      let json: { data?: { reviews?: ApiReview[]; params?: { count?: number } } };
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error('API response is not JSON');
      }
      if (json?.data?.params?.count !== undefined) total = json.data.params.count;
      list = json?.data?.reviews ?? [];
      break;
    }
    if (list.length === 0) break;
    let oldest: number | null = null;
    for (const x of list) {
      const iso = x.updatedTime ?? x.createdTime ?? null;
      const date = iso ? new Date(iso) : null;
      const t = date?.getTime() ?? Number.POSITIVE_INFINITY;
      if (oldest === null || t < oldest) oldest = t;
      collected.push({
        author: x.author?.name?.trim() || 'Anonymous',
        date,
        rating: x.rating !== undefined && x.rating !== null ? Number(x.rating) : null,
        text: x.text ?? '',
      });
    }
    console.log(`   [api] page ${pageNo}: ${list.length} reviews (total ${total})`);
    if (oldest !== null && oldest < cutoff.getTime()) break; // reached reviews older than the period
    if (list.length < 50) break; // last page
  }
  return collected
    .filter((r) => r.date !== null && r.date.getTime() >= cutoff.getTime())
    .sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
}

// ---- the branch list ----

/**
 * All chain branches straight from the chain page (plain HTTP). The
 * embedded search state contains EVERY organization of the chain — the
 * rendered cards plus the ones the SPA would lazy-render on scroll —
 * each with an address and an orgId.
 */
async function discoverBranches(): Promise<Branch[]> {
  if (!CHAIN_URL) {
    throw new Error('YANDEX_CHAIN_URL is not set in .env (chain page URL on Yandex Maps)');
  }
  const res = await fetch(CHAIN_URL, { headers: { 'User-Agent': BROWSER_UA } });
  if (!res.ok) throw new Error(`chain page HTTP ${res.status}`);
  const html = await res.text();
  if (looksLikeCaptchaHtml(html)) {
    throw new Error('Yandex served a captcha page instead of the chain list');
  }

  const found = new Map<string, string>();

  // state entries: {"address":"…","coordinates":[…],"displayCoordinates":[…],
  // "bounds":[[…],[…]],"uri":"ymapsbm1://org?oid=<id>"}
  for (const m of html.matchAll(/"address":"([^"]+)","coordinates":\[[^\]]*\],"displayCoordinates":\[[^\]]*\],"bounds":\[\[[^\]]*\],\[[^\]]*\]\],"uri":"ymapsbm1:\/\/org\?oid=(\d+)"/g)) {
    const address = m[1];
    const orgId = m[2];
    if (!address || !orgId || found.has(orgId)) continue;
    // "Region, City, street, house" → "street, house"; shorter addresses stay as-is
    const name = address.replace(/^[^,]+,\s*[^,]+,\s*/, '').trim() || address;
    found.set(orgId, name);
  }

  // rendered cards as an additional source (img alt "Name (street, …), type")
  for (const m of html.matchAll(/data-id="(\d+)"[\s\S]{0,3000}?<img[^>]*alt="([^"]+)"/g)) {
    const orgId = m[1];
    const alt = m[2];
    if (!orgId || !alt || found.has(orgId)) continue;
    const rawName = alt.match(/\(([^)]+)\)/)?.[1];
    const name = rawName?.replace(/^[^,]+,\s*[^,]+,\s*/, '').trim();
    if (name) found.set(orgId, name);
  }

  return [...found.entries()].map(([orgId, name]) => ({ orgId, name }));
}

/**
 * Collects reviews for the last daysBack days (yesterday by default)
 * across all chain branches. To send the collected reviews by email use
 * collectReviews() from index.ts (one email for both platforms).
 */
export async function collectYandexReviews(opts: ReportOptions = {}): Promise<ReviewsCollection> {
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const cutoff = getCutoffDate(daysBack);

  const branches = await discoverBranches();
  if (branches.length === 0) {
    throw new Error('no branches found on the chain page — check YANDEX_CHAIN_URL');
  }

  console.log(`Collecting reviews via the maps API, branches: ${branches.length}...`);
  const results: BranchResult[] = [];
  const failures: string[] = [];

  for (const branch of branches) {
    console.log(`Collecting reviews: ${branch.name}...`);
    const branchResult: BranchResult = { branch: branch.name, orgId: branch.orgId, reviewsCount: 0, reviews: [] };
    results.push(branchResult);
    try {
      const reviews = await fetchBranchReviews(branch, cutoff);
      branchResult.reviewsCount = reviews.length;
      console.log(`   found for ${daysBack} d.: ${reviews.length}`);
      for (const r of reviews) {
        branchResult.reviews.push({
          author: r.author,
          rating: r.rating,
          date: r.date ? r.date.toISOString() : '',
          text: r.text,
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failures.push(`${branch.name} (${branch.orgId}): ${msg}`);
      console.error(`[!] Skipping "${branch.name}": ${msg}`);
    }
  }

  // skipped branches summary — big and visible, easy to spot in logs
  if (failures.length > 0) {
    console.error('\n' + '='.repeat(60));
    console.error(`SKIPPED BRANCHES (${failures.length} of ${results.length}):`);
    for (const f of failures) console.error(`   x ${f}`);
    console.error('='.repeat(60) + '\n');
  }

  const total = results.reduce((sum, b) => sum + b.reviewsCount, 0);
  return { total, branches: results, failures };
}

async function main(): Promise<void> {
  const { total, branches } = await collectYandexReviews();

  console.log(`Done: ${total} reviews across ${branches.length} branches`);
  for (const b of branches) {
    console.log(`   - ${b.branch}: ${b.reviewsCount}`);
  }
}

// direct run (npx tsx reviews.ts) — a test pass that writes no files;
// when imported from index.ts only collectYandexReviews() is used
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('Execution error:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}

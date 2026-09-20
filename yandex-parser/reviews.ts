/**
* Collects reviews (author, rating, text, date) for the last daysBack days
* across all branches of a chain on Yandex Maps.
* Used from index.ts (result goes into daily_report.json); direct run
* (npx tsx yandex-parser/reviews.ts) prints a summary to the console.
*
* The branch list is NOT maintained by hand: the script opens the chain
* page (YANDEX_CHAIN_URL from .env), scrolls through the list of cards
* and collects orgId + address + review URL.
*
* IMPORTANT: Yandex Maps has no official reviews API, so this is scraping
* of a public page in a real browser. Selectors may change — if you get
* 0 reviews, inspect the current markup in DevTools.
*/

import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import * as dotenv from 'dotenv';
import { DEFAULT_DAYS_BACK } from '../options.js';
import type { ReportOptions } from '../options.js';

dotenv.config({ quiet: true });

interface Branch {
  name: string;
  orgId: string;
  reviewsUrl: string; // review page URL of the branch (built from the chain card link)
}

// chain page on Yandex Maps — the source of the branch list (from .env)
const CHAIN_URL = process.env.YANDEX_CHAIN_URL;

// Yandex Maps origin — derived from the chain URL, so the fallback links
// match the user's domain (yandex.by / yandex.ru / yandex.kz ...)
const MAPS_ORIGIN = CHAIN_URL ? new URL(CHAIN_URL).origin : 'https://yandex.by';

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

function getCutoffDate(daysBack: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  // count from the start of the day: a run at 8am on the 11th
  // collects reviews since 00:00 on the 10th
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Collects branches from the chain page: scrolls the list with the mouse
 * (the panel is virtualized — only visible cards are in the DOM) and
 * extracts orgId from the card data-id, the address from the photo alt
 * "Name (street, ...)" and the review URL from the card link.
 */
async function discoverBranches(page: Page): Promise<Branch[]> {
  if (!CHAIN_URL) {
    throw new Error('YANDEX_CHAIN_URL is not set in .env (chain page URL on Yandex Maps)');
  }
  await page.goto(CHAIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  await page.mouse.move(210, 400); // cursor over the left list panel

  const found = new Map<string, string>();
  let stagnantRounds = 0;
  let lastCount = 0;

  for (let round = 0; round < 50; round++) {
    await page.mouse.wheel(0, 800);
    await page.waitForTimeout(400);

    const cards = await page.evaluate(() => {
      return [...document.querySelectorAll('.search-snippet-view__body[data-id]')]
        .map((el) => {
          const link = el.querySelector('a[href*="/maps/org/"]') as HTMLAnchorElement | null;
          return {
            orgId: el.getAttribute('data-id') || '',
            // card path like "/maps/org/slug/ID/" — the reviews URL is built from it
            href: link?.getAttribute('href') || '',
            alt: el.querySelector('img')?.getAttribute('alt') || '',
          };
        });
    });
    for (const c of cards) {
      // alt like "Name (street, 5), type" — the address is in parentheses
      const raw = c.alt.match(/\(([^)]+)\)/)?.[1];
      // "Region, City, Main street" -> "Main street": drop the first two
      // segments of an address shaped like "Region, City, street..."
      const name = raw?.replace(/^[^,]+,\s*[^,]+,\s*/, '');
      if (c.orgId && name && !found.has(c.orgId)) {
        found.set(c.orgId, JSON.stringify({ name, href: c.href }));
      }
    }

    if (found.size === lastCount) {
      stagnantRounds += 1;
      if (stagnantRounds > 3) break; // list exhausted
    } else {
      stagnantRounds = 0;
    }
    lastCount = found.size;
  }

  return [...found.entries()].map(([orgId, json]) => {
    const { name, href } = JSON.parse(json) as { name: string; href: string };
    // review URL is built from the card path: "/maps/org/slug/ID/" + "reviews/"
    const reviewsUrl = href
      ? new URL(href, CHAIN_URL).toString().replace(/\/?$/, '/') + 'reviews/'
      : `${MAPS_ORIGIN}/maps/org/${orgId}/reviews/`;
    return { orgId, name, reviewsUrl };
  });
}

interface RawReview {
  author: string;
  date: string | null;
  rating: string | null;
  text: string;
}

/**
 * Reads ALL mounted cards with a single browser call — orders of magnitude
 * faster than 4 locator round-trips per card.
 */
async function parseMountedCards(page: Page): Promise<RawReview[]> {
  return page.evaluate(() => {
    return [...document.querySelectorAll<HTMLElement>('.business-review-view')].map((card) => {
      const author = card.querySelector('.business-review-view__author-name')?.textContent?.trim() ?? 'Anonymous';
      // the date arrives as a ready ISO value from meta itemprop="datePublished"
      // — no need to parse human text like "September 10, 2024"
      const date = card.querySelector('meta[itemprop="datePublished"]')?.getAttribute('content') ?? null;
      const rating = card.querySelector('meta[itemprop="ratingValue"]')?.getAttribute('content') ?? null;
      // the full review text is already in the DOM, no "show more" click needed
      const text = card.querySelector('.spoiler-view__text-container')?.textContent?.trim() ?? '';
      return { author, date, rating, text };
    });
  });
}

function toReview(raw: RawReview): Review {
  return {
    author: raw.author,
    date: raw.date ? new Date(raw.date) : null,
    rating: raw.rating !== null ? parseFloat(raw.rating) : null,
    text: raw.text,
  };
}

/**
 * Opens the sort menu and picks "newest first" with retries.
 * Fully locale-independent: the trigger is found by its CSS class
 * (.rating-ranking-view) and the popup options keep a fixed order
 * (relevant, NEWEST, negative first, positive first) — we click
 * the second .rating-ranking-view__popup-line. A click on a freshly
 * mounted trigger sometimes does not open the menu (handlers are not
 * attached yet), hence the retries.
 */
async function switchSortToNewest(page: Page): Promise<boolean> {
  const trigger = page.locator('.rating-ranking-view').first();
  const options = page.locator('.rating-ranking-view__popup-line');

  for (let attempt = 1; attempt <= 3; attempt++) {
    // the menu may have stayed open from a previous attempt — no trigger click needed
    if ((await options.count()) === 0) {
      const clicked = await trigger.click({ timeout: 6000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked && attempt > 1) return false; // trigger was there and vanished — give up
    }

    const menuOpened = await options.first().waitFor({ state: 'visible', timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (menuOpened && (await options.count()) >= 2) {
      const picked = await options.nth(1).click({ timeout: 6000 })
        .then(() => page.waitForTimeout(1500))
        .then(() => true)
        .catch(() => false);
      if (picked) return true;
    }

    // the trigger click went through but the menu did not open — wait and retry
    await page.waitForTimeout(1500);
  }
  return false;
}

async function fetchBranchReviews(page: Page, branch: { orgId: string; reviewsUrl: string }, cutoff: Date): Promise<Review[]> {
  await page.goto(branch.reviewsUrl, { waitUntil: 'domcontentloaded' });

  // if the sort control does not appear within 5s — skip the branch:
  // that happens for places without reviews (nothing to sort) or on a captcha
  const buttonReady = await page.locator('.rating-ranking-view').first()
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  if (!buttonReady) {
    await page.screenshot({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), `debug_fail_${branch.orgId}.png`) })
      .catch(() => {});
    throw new Error(`sort button did not appear within 5s — no reviews, captcha or changed markup (screenshot: debug_fail_${branch.orgId}.png)`);
  }

  // let the app attach handlers: a click right after mount does not open the menu
  await page.waitForTimeout(1200);

  const sortClicked = await switchSortToNewest(page);
  if (!sortClicked) {
    // save a screenshot to see what Yandex actually served (captcha/stub/new markup)
    await page.screenshot({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), `debug_fail_${branch.orgId}.png`) })
      .catch(() => {});
    throw new Error(`sort menu did not open in 3 attempts (screenshot: debug_fail_${branch.orgId}.png)`);
  }

  // the review list is virtualized: old cards are removed from the DOM while
  // scrolling, so every round we rescan ALL mounted cards; duplicates are cut
  // by the signature dedup (an index-based parser lost reviews after window shifts)
  const collected = new Map<string, Review>();
  const noDateKeys = new Set<string>();
  let stagnantRounds = 0;
  let lastCount = 0;

  await page.mouse.move(360, 500); // cursor over the LEFT review panel — the wheel over the map does not scroll the list

  for (let round = 0; round < 120; round++) {
    const mountedBefore = await page.locator('.business-review-view').count();

    if (mountedBefore === 0) {
      throw new Error('no review cards on the page — no reviews, captcha or changed markup');
    }

    await page.mouse.wheel(0, 2500);
    // wait for the list to actually grow instead of a fixed pause; capped at 1.2s
    await page.waitForFunction(
      (prev) => document.querySelectorAll('.business-review-view').length > prev,
      mountedBefore,
      { timeout: 1200 },
    ).catch(() => {});

    for (const raw of await parseMountedCards(page)) {
      const review = toReview(raw);
      const key = `${review.author}|${review.date?.getTime() ?? ''}|${review.text.slice(0, 80)}`;
      if (!collected.has(key)) collected.set(key, review);
      if (review.date === null) noDateKeys.add(`${review.author}|${review.text.slice(0, 80)}`);
    }

    const reviews = [...collected.values()];
    const oldestSoFar = reviews
      .map((r) => r.date)
      .filter((d): d is Date => d !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    if (oldestSoFar && oldestSoFar < cutoff) break; // reached reviews older than the period
    if (reviews.length === lastCount) {
      stagnantRounds += 1;
      if (stagnantRounds > 5) break; // nothing more loads — end of list
    } else {
      stagnantRounds = 0;
    }
    lastCount = reviews.length;
  }

  if (noDateKeys.size > 0) {
    console.warn(`   [!] ${noDateKeys.size} reviews without a recognized date — check the datePublished selector`);
  }

  return [...collected.values()].filter((r) => r.date !== null && r.date >= cutoff);
}

export interface ReviewsCollection {
  total: number;
  branches: BranchResult[];
  /** Branches that could not be collected (captcha/no reviews/breakage) — for logs */
  failures: string[];
}

/**
 * Collects reviews for the last daysBack days (yesterday by default)
 * across all chain branches. Opens a visible browser (Yandex blocks headless).
 * To also send the collected reviews by email use collectReviews()
 * from index.ts (one email for both platforms).
 */
export async function collectYandexReviews(opts: ReportOptions = {}): Promise<ReviewsCollection> {
  const daysBack = opts.daysBack ?? DEFAULT_DAYS_BACK;
  const cutoff = getCutoffDate(daysBack);
  const browser: Browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } });
  // Yandex serves a "limited" stub to headless browsers — mask webdriver and run visible
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  console.log('Collecting the branch list from the chain page...');
  const branches = await discoverBranches(page);
  if (branches.length === 0) {
    await browser.close();
    throw new Error('no branches found — check YANDEX_CHAIN_URL and the list markup');
  }
  console.log(`   branches found: ${branches.length}`);
  for (const b of branches) console.log(`   - ${b.name} (${b.orgId})`);

  const results: BranchResult[] = [];
  const failures: string[] = [];

  for (const branch of branches) {
    console.log(`Collecting reviews: ${branch.name}...`);
    const branchResult: BranchResult = {
      branch: branch.name,
      orgId: branch.orgId,
      reviewsCount: 0,
      reviews: [],
    };
    results.push(branchResult);
    try {
      const reviews = await fetchBranchReviews(page, branch, cutoff);
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

  await browser.close();

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

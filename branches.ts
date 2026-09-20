/**
* Branch name mapping shared by the Google and Yandex collectors.
*
* branches.json in the USER'S current directory (see branches.example.json):
* key — a substring of the raw platform address, value — the branch name
* in the report. No file or no match — the address is cleaned automatically.
* The same aliases apply to Yandex Metrika organization names, so branches
* of both platforms can be named uniformly.
*/

import * as fs from 'fs';
import * as path from 'path';

/** Private-use / zero-width characters Yandex and Google addresses sometimes carry. */
const INVISIBLE = /[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g;

export function loadBranchAliases(): Record<string, string> {
  const file = path.join(process.cwd(), 'branches.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
    return Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('_')));
  } catch {
    console.warn('[branches] branches.json not found or invalid — branches will use auto names');
    return {};
  }
}

/** Google address -> branch name (aliases; fallback — cleaned address). */
export function normalizeBranchName(address: string | null, fallback: string, aliases: Record<string, string>): string {
  if (!address) return fallback;
  const cleaned = address.replace(INVISIBLE, '').trim();
  for (const [key, alias] of Object.entries(aliases)) {
    if (cleaned.includes(key)) return alias;
  }
  return cleaned.split(',')[0]?.trim() || fallback;
}

/**
 * Yandex Metrika organization name like
 * "Мінская вобласць, Барысаў, вуліца Будаўнікоў, 45А" -> "вуліца Будаўнікоў, 45А":
 * aliases are matched first against the full name, then against the street
 * part (the first two segments — region and city — are dropped).
 */
export function cleanYandexOrgName(full: string, aliases: Record<string, string>): string {
  const cleaned = full.replace(INVISIBLE, '').trim();
  for (const [key, alias] of Object.entries(aliases)) {
    if (cleaned.includes(key)) return alias;
  }
  // "Region, City, street..." -> "street..."
  const street = cleaned.replace(/^[^,]+,\s*[^,]+,\s*/, '');
  for (const [key, alias] of Object.entries(aliases)) {
    if (street.includes(key)) return alias;
  }
  return street || cleaned;
}

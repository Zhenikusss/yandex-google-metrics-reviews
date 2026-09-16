/**
* Shared Google Business Profile auth and the location list.
* Used by metrika.ts and reviews.ts.
*
* Auth comes from environment variables only (.env):
*   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET — OAuth client from Google Cloud Console
*   GOOGLE_REFRESH_TOKEN                     — long-lived refresh token
* (Google access tokens live ~1 hour, so they are refreshed every run)
*/

import * as dotenv from 'dotenv';

dotenv.config({ quiet: true });

export interface GoogleLocation {
  id: string;      // numeric location id
  path: string;    // full API path: accounts/XXX/locations/YYY
  title: string;   // location title
  address: string | null; // one-line address (when present)
}

/** A fresh access token from the refresh token (a plain POST, no SDK). */
export async function getGoogleAccessToken(): Promise<string> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN are not set (.env)');
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    throw new Error(`OAuth refresh HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json() as { access_token?: string };
  if (!data.access_token) throw new Error('OAuth returned no access_token');

  return data.access_token;
}

/**
 * All locations of all business accounts of the user.
 * The list is live: a newly shared location shows up here right away.
 */
export async function listGoogleLocations(accessToken: string): Promise<GoogleLocation[]> {
  const accRes = await fetch('https://mybusinessaccountmanagement.googleapis.com/v1/accounts', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!accRes.ok) {
    throw new Error(`Accounts list HTTP ${accRes.status}: ${(await accRes.text()).slice(0, 200)}`);
  }
  const accounts: { name: string }[] = (await accRes.json()).accounts ?? [];

  const locations: GoogleLocation[] = [];
  for (const acc of accounts) {
    const locRes = await fetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${acc.name}/locations?readMask=name,title,storefrontAddress`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!locRes.ok) continue; // an account without accessible locations — skip
    const page: {
      locations?: { name: string; title?: string; storefrontAddress?: { addressLines?: string[] } }[];
    } = await locRes.json();
    for (const loc of page.locations ?? []) {
      const id = loc.name.split('/').pop();
      if (!id) continue;
      locations.push({
        id,
        // the BI API sometimes returns the name without the account prefix — build the full path ourselves
        path: `${acc.name}/locations/${id}`,
        title: loc.title ?? id,
        address: loc.storefrontAddress?.addressLines?.join(', ') ?? null,
      });
    }
  }

  if (locations.length === 0) {
    throw new Error('The business account returned no locations (check that the Business Profile API is enabled in Cloud Console)');
  }
  return locations;
}

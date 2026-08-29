const OPENID_ENDPOINT = 'https://steamcommunity.com/openid/login';
const STEAM_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function createSteamOpenIdRedirect({ publicBaseUrl, state }) {
  const url = new URL(OPENID_ENDPOINT);
  url.searchParams.set('openid.ns', 'http://specs.openid.net/auth/2.0');
  url.searchParams.set('openid.mode', 'checkid_setup');
  url.searchParams.set('openid.return_to', `${publicBaseUrl}/auth/steam/callback?state=${encodeURIComponent(state)}`);
  url.searchParams.set('openid.realm', publicBaseUrl);
  url.searchParams.set('openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select');
  url.searchParams.set('openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select');
  return url.toString();
}

export async function verifySteamOpenIdCallback(searchParams, { fetchImpl = fetch } = {}) {
  const claimedId = searchParams.get('openid.claimed_id');
  const identity = searchParams.get('openid.identity');
  const match = STEAM_ID_PATTERN.exec(claimedId ?? '');
  if (!match || identity !== claimedId) throw new Error('Steam OpenID response does not contain a valid claimed identity');
  if (searchParams.get('openid.op_endpoint') !== OPENID_ENDPOINT) throw new Error('Steam OpenID endpoint is invalid');

  const body = new URLSearchParams();
  for (const [key, value] of searchParams) if (key.startsWith('openid.')) body.set(key, value);
  body.set('openid.mode', 'check_authentication');
  const response = await fetchImpl(OPENID_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new Error(`Steam OpenID verification returned HTTP ${response.status}`);
  const verified = await response.text();
  if (!/^is_valid\s*:\s*true\s*$/mi.test(verified)) throw new Error('Steam OpenID verification failed');
  return { steamId: match[1] };
}

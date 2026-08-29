const OWNED_GAMES_URL = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/';

export async function fetchOwnedGames({ apiKey, steamId, fetchImpl = fetch }) {
  if (!apiKey) throw new Error('STEAM_WEB_API_KEY is not configured');
  if (!/^\d{17}$/.test(steamId)) throw new Error('steamId must be a 17-digit SteamID64');

  const url = new URL(OWNED_GAMES_URL);
  url.searchParams.set('steamid', steamId);
  url.searchParams.set('include_appinfo', 'true');
  url.searchParams.set('include_played_free_games', 'true');

  const response = await fetchImpl(url, { headers: { 'x-webapi-key': apiKey } });
  if (!response.ok) throw new Error(`Steam returned HTTP ${response.status}`);

  const body = await response.json();
  const steamResponse = body.response;
  // Steam omits game_count for private/unavailable libraries. An empty visible
  // library explicitly reports game_count: 0, so the two are not conflated.
  const libraryVisible = Number.isInteger(steamResponse?.game_count);
  const games = steamResponse?.games ?? [];
  return {
    steamId,
    libraryVisible,
    gameCount: libraryVisible ? steamResponse.game_count : null,
    games: games.map(({ appid, name, playtime_forever }) => ({
      appId: appid,
      name,
      playtimeMinutes: playtime_forever ?? 0,
    })),
  };
}

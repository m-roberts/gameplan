const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const API_URL = 'https://api.igdb.com/v4';
const STEAM_SOURCE_CATEGORY = 1;

export function derivePlayerSupport(multiplayerModes) {
  if (!Array.isArray(multiplayerModes) || !multiplayerModes.length) return null;
  const modes = multiplayerModes.filter((mode) => mode && typeof mode === 'object');
  if (!modes.length) return null;
  const online = modes.some((mode) => mode.online === true);
  const onlineCoop = modes.some((mode) => mode.onlinecoop === true);
  const localMultiplayer = modes.some((mode) => mode.offline === true || mode.offlinemax != null);
  const localCoop = modes.some((mode) => mode.offlinecoop === true || mode.offlinecoopmax != null);
  const splitScreen = modes.some((mode) => mode.splitscreen === true || mode.splitscreenonline === true);
  const multiplayer = online || onlineCoop || localMultiplayer || localCoop || splitScreen;
  const maxPlayers = Math.max(0, ...modes.flatMap((mode) => [
    mode.onlinemax,
    mode.onlinecoopmax,
    mode.offlinemax,
    mode.offlinecoopmax,
  ].filter((value) => Number.isInteger(value) && value > 0)));
  return {
    minPlayers: multiplayer ? 2 : 1,
    maxPlayers: maxPlayers || null,
    online,
    onlineCoop,
    localMultiplayer,
    localCoop,
    splitScreen,
  };
}

export function mapIgdbGame(game) {
  if (!game || !Number.isInteger(game.id)) return null;
  const support = derivePlayerSupport(game.multiplayer_modes);
  return support ? { providerGameId: game.id, providerName: game.name ?? null, ...support } : null;
}

export class IgdbClient {
  constructor({ clientId, clientSecret, fetchImpl = fetch }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  configured() { return Boolean(this.clientId && this.clientSecret); }

  async token() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    const url = new URL(TOKEN_URL);
    url.searchParams.set('client_id', this.clientId);
    url.searchParams.set('client_secret', this.clientSecret);
    url.searchParams.set('grant_type', 'client_credentials');
    const response = await this.fetch(url, { method: 'POST' });
    if (!response.ok) throw new Error(`IGDB token request returned HTTP ${response.status}`);
    const body = await response.json();
    if (!body.access_token) throw new Error('IGDB token response did not contain an access token');
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + Math.max(60, Number(body.expires_in ?? 3600) - 60) * 1000;
    return this.accessToken;
  }

  async findSteamGame(appId) {
    const response = await this.fetch(`${API_URL}/external_games`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Client-ID': this.clientId, Authorization: `Bearer ${await this.token()}` },
      body: `fields game; where uid = "${Number(appId)}" & category = ${STEAM_SOURCE_CATEGORY}; limit 1;`,
    });
    if (!response.ok) throw new Error(`IGDB external-game lookup returned HTTP ${response.status}`);
    const externalGames = await response.json();
    const gameId = externalGames?.[0]?.game;
    if (!Number.isInteger(gameId)) return null;
    const gameResponse = await this.fetch(`${API_URL}/games`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Client-ID': this.clientId, Authorization: `Bearer ${await this.token()}` },
      body: `fields name,multiplayer_modes.*; where id = ${gameId}; limit 1;`,
    });
    if (!gameResponse.ok) throw new Error(`IGDB game lookup returned HTTP ${gameResponse.status}`);
    return mapIgdbGame((await gameResponse.json())?.[0]);
  }
}

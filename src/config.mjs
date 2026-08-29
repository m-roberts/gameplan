function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

export function loadConfig(env = process.env) {
  const publicBaseUrl = new URL(requiredFrom(env, 'PUBLIC_BASE_URL'));
  if (!['http:', 'https:'].includes(publicBaseUrl.protocol)) {
    throw new Error('PUBLIC_BASE_URL must be an HTTP(S) URL');
  }

  const appSecret = requiredFrom(env, 'APP_SECRET');
  if (appSecret.length < 32) throw new Error('APP_SECRET must contain at least 32 characters');

  const memberSyncIntervalSeconds = Number(env.DISCORD_MEMBER_SYNC_INTERVAL_SECONDS ?? 900);
  const oauthClients = parseOAuthClients(env.OAUTH_CONFIDENTIAL_CLIENTS);
  return {
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: publicBaseUrl.toString().replace(/\/$/, ''),
    databaseUrl: requiredFrom(env, 'DATABASE_URL'),
    appSecret,
    steamWebApiKey: requiredFrom(env, 'STEAM_WEB_API_KEY'),
    igdbClientId: env.IGDB_CLIENT_ID || null,
    igdbClientSecret: env.IGDB_CLIENT_SECRET || null,
    discordPublicKey: requiredFrom(env, 'DISCORD_PUBLIC_KEY'),
    discordBotToken: env.DISCORD_BOT_TOKEN || null,
    oauthClients,
    feedbackUrl: optionalHttpUrl(env.FEEDBACK_URL),
    feedbackWebhookSecret: env.FEEDBACK_WEBHOOK_SECRET || null,
    discordMemberSyncIntervalMs: Math.max(60_000, Number.isFinite(memberSyncIntervalSeconds) ? memberSyncIntervalSeconds * 1000 : 900_000),
  };
}

function parseOAuthClients(value) {
  if (!value) return [];
  let clients;
  try { clients = JSON.parse(value); } catch { throw new Error('OAUTH_CONFIDENTIAL_CLIENTS must be valid JSON'); }
  if (!Array.isArray(clients)) throw new Error('OAUTH_CONFIDENTIAL_CLIENTS must be a JSON array');
  return clients.map((client) => {
    if (!client?.id || !client.secret || !client.redirectUri) throw new Error('every OAuth client needs id, secret, and redirectUri');
    const redirectUri = new URL(client.redirectUri);
    if (redirectUri.protocol !== 'https:') throw new Error('OAuth client redirectUri must use HTTPS');
    return { id: client.id, secret: client.secret, redirectUri: redirectUri.toString() };
  });
}

function optionalHttpUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('FEEDBACK_URL must be an HTTP(S) URL');
  return url.toString();
}

function requiredFrom(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

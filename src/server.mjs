import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
import { createDatabase } from './database.mjs';
import { deferredInteractionResponse, discordIdentity, ephemeral, prepareDiscordMessage, verifyDiscordSignature } from './discord.mjs';
import { IdentityService } from './identity.mjs';
import { DiscordBot, inviteCard } from './discord-bot.mjs';
import { PlannerService } from './planner.mjs';
import { GuildPolicyService } from './guild-policy.mjs';
import { handleDiscordInteraction } from './interaction-router.mjs';
import { publishLfg, updateLfgCard } from './lfg-discussion.mjs';
import { DiscordFlowService } from './discord-flow.mjs';
import { fetchOwnedGames } from './steam.mjs';
import { createSteamOpenIdRedirect, verifySteamOpenIdCallback } from './steam-openid.mjs';
import { NotificationService } from './notifications.mjs';
import { FeedbackNotificationService } from './feedback-notifications.mjs';
import { RallyService } from './rallies.mjs';
import { IgdbClient } from './igdb.mjs';
import { ExternalGameMetadataService } from './external-game-metadata.mjs';
import { discordTraceContext, recordDiscordTrace } from './discord-trace.mjs';
import { DiscordMemberSync } from './member-sync.mjs';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const identity = new IdentityService({ database, appSecret: config.appSecret });
const planner = new PlannerService({ database });
const guildPolicy = new GuildPolicyService({ database });
const flows = new DiscordFlowService({ database });
const trace = async (event) => {
  try { await recordDiscordTrace(database, event); } catch (error) { console.error('[discord-trace] record failed', error); }
};
const bot = new DiscordBot({ token: config.discordBotToken, trace });
const memberSync = config.discordBotToken ? new DiscordMemberSync({ database, bot, intervalMs: config.discordMemberSyncIntervalMs }) : null;
const notifications = new NotificationService({ database });
const feedbackNotifications = new FeedbackNotificationService({ database });
const rallies = new RallyService({ database, planner });
const externalGameMetadata = new ExternalGameMetadataService({
  database,
  client: new IgdbClient({ clientId: config.igdbClientId, clientSecret: config.igdbClientSecret }),
});

async function issueBrowserUrl(actor, { continueTo = null } = {}) {
  const link = await identity.issueBrowserLink(actor);
  const launchUrl = new URL(`/launch/${link.token}`, config.publicBaseUrl);
  if (continueTo) launchUrl.searchParams.set('continue', continueTo);
  return launchUrl.toString();
}
function allowsBrowserAlternative(interaction) {
  if (interaction.type !== 2 || interaction.data?.name !== 'gameplan') return false;
  const first = interaction.data.options?.[0];
  const action = first?.options?.[0]?.name ?? first?.name ?? 'plan';
  return ['invite', 'server', 'me', 'group', 'games', 'sync'].includes(action);
}
async function sendInvites(session) {
  await Promise.all(session.rsvps.filter((r) => r.discordUserId !== session.hostDiscordUserId && r.response === 'pending').map(async (r) => {
    try { const message = await bot.dm(r.discordUserId, inviteCard({ ...session, browserUrl: await issueBrowserUrl({ discordUserId: r.discordUserId, guildId: session.guildId }) })); await database.query('INSERT INTO session_dm_invites (game_session_id, discord_user_id, channel_id, message_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [session.id, r.discordUserId, message.channel_id, message.id]); } catch (error) { console.warn(`Could not DM invitation to ${r.discordUserId}: ${error.message}`); }
  }));
}
async function publishSessionToFeed(session) {
  try {
    const policy = await guildPolicy.get(session.guildId);
    if (!policy.defaultLfgChannelId) return { published: false, error: 'no Session Feed is configured; ask an admin to run /gameplan server.' };
    const canPost = (await bot.sendableTextChannels(session.guildId)).some((channel) => channel.id === policy.defaultLfgChannelId);
    if (!canPost) return { published: false, error: 'GamePlan cannot post in the configured Session Feed; ask an admin to check its View Channel and Send Messages permissions.' };
    await publishLfg({ session, channelId: policy.defaultLfgChannelId, bot, database, notifications });
    return { published: true, channelId: policy.defaultLfgChannelId };
  } catch (error) {
    console.warn(`Could not publish GamePlan session ${session.id} to its Session Feed: ${error.message}`);
    return { published: false, error: 'GamePlan could not publish the card; ask an admin to check the Session Feed and try planning again.' };
  }
}
async function announceGameTonightChange({ sessionId, actorDiscordUserId, content, changeKey }) {
  const session = await planner.getSession(sessionId, actorDiscordUserId);
  const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [sessionId]);
  try { await updateLfgCard({ session, post, bot }); } catch (error) { console.warn(`Could not update GamePlan Session Feed card after changing Games Tonight: ${error.message}`); }
  if (post.rowCount) {
    try { await bot.send(post.rows[0].discussion_thread_id, { content, allowed_mentions: { parse: [], users: [] } }); }
    catch (error) { console.warn(`Could not post Games Tonight activity: ${error.message}`); }
  }
  await notifications.queueGameNightChange({ session, content, changeKey });
}
const indexHtml = await readFile(new URL('../public/index.html', import.meta.url));
const appJs = await readFile(new URL('../public/app.js', import.meta.url));
const appCss = await readFile(new URL('../public/app.css', import.meta.url));
const sessionCookieName = config.publicBaseUrl.startsWith('https:') ? '__Host-gameplan_session' : 'gameplan_session';
const secureCookies = config.publicBaseUrl.startsWith('https:');

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function redirect(response, location, headers = {}) {
  response.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  response.end();
}

function html(response, status, body) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body exceeds 1 MB'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function readJson(request) {
  const body = await readBody(request);
  if (!body.length) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('request body must be valid JSON');
  }
}

async function readForm(request) { return new URLSearchParams((await readBody(request)).toString('utf8')); }

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const index = part.indexOf('=');
    return index === -1 ? [] : [[part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]];
  }));
}

function cookie(name, value, { httpOnly = false, maxAge = 0, sameSite = 'Lax' } = {}) {
  const attributes = [`${name}=${encodeURIComponent(value)}`, 'Path=/', `SameSite=${sameSite}`, `Max-Age=${maxAge}`];
  if (secureCookies) attributes.push('Secure');
  if (httpOnly) attributes.push('HttpOnly');
  return attributes.join('; ');
}

function clearCookies() {
  return [
    cookie(sessionCookieName, '', { httpOnly: true }),
    cookie('gameplan_csrf', '', { sameSite: 'Strict' }),
  ];
}

async function requireSession(request, response, { csrf = false, respond = true } = {}) {
  const cookies = parseCookies(request.headers.cookie);
  const session = await identity.getBrowserSession(cookies[sessionCookieName]);
  if (!session) {
    if (respond) json(response, 401, { error: 'Open a fresh GamePlan Browser Link from Discord.' });
    return null;
  }
  if (csrf && !identity.validCsrfToken(session, request.headers['x-gameplan-csrf'])) {
    json(response, 403, { error: 'invalid CSRF token' });
    return null;
  }
  return { session, sessionToken: cookies[sessionCookieName] };
}

function findOAuthClient(id) { return config.oauthClients.find((client) => client.id === id) ?? null; }
function oauthClientCredentials(request, form) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Basic ')) return { clientId: form.get('client_id'), clientSecret: form.get('client_secret') };
  const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  return separator === -1 ? {} : { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
}
function oauthDeniedRedirect(client, state) {
  const location = new URL(client.redirectUri);
  location.searchParams.set('error', 'access_denied');
  if (state) location.searchParams.set('state', state);
  return location.toString();
}

async function syncSteamLibrary(discordUserId, connection) {
  try {
    const result = await fetchOwnedGames({ apiKey: config.steamWebApiKey, steamId: connection.steam_id });
    const snapshot = await identity.recordOwnershipSnapshot({ discordUserId, steamId: connection.steam_id, result });
    void externalGameMetadata.refreshGames(result.games).catch((error) => console.warn(`IGDB enrichment failed without blocking Steam sync: ${error.message}`));
    return { ...snapshot, gameCount: result.gameCount };
  } catch (error) {
    await identity.recordOwnershipSnapshot({
      discordUserId,
      steamId: connection.steam_id,
      result: null,
      errorMessage: error.message,
    });
    throw error;
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, config.publicBaseUrl);
  try {
    if (request.method === 'GET' && url.pathname === '/healthz') {
      await database.ping();
      const voice = await database.query('SELECT connected_at,last_event_at FROM voice_gateway_status WHERE singleton=true');
      return json(response, 200, {
        service: 'gameplan',
        database: 'reachable',
        steamConfigured: true,
        discordInteractionsConfigured: true,
        discordBotConfigured: Boolean(config.discordBotToken),
        voiceGateway: voice.rowCount ? { connectedAt: voice.rows[0].connected_at, lastEventAt: voice.rows[0].last_event_at } : null,
      });
    }

    if (request.method === 'GET' && url.pathname === '/') return html(response, 200, indexHtml);
    if (request.method === 'GET' && url.pathname === '/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(appJs);
    }
    if (request.method === 'GET' && url.pathname === '/app.css') {
      response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      return response.end(appCss);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/launch/')) {
      const token = url.pathname.slice('/launch/'.length);
      const redeemed = await identity.redeemBrowserLink(token);
      if (!redeemed) return html(response, 410, '<h1>This GamePlan Browser Link is no longer valid.</h1><p>Run <code>/gameplan me</code> in Discord to get a new one.</p>');
      // A deployment may opt into one feedback destination. A browser link can
      // continue there only when it exactly matches that configured URL, which
      // keeps this private-link endpoint from becoming an open redirect.
      const continueTo = url.searchParams.get('continue');
      const destination = continueTo && continueTo === config.feedbackUrl ? continueTo : '/';
      return redirect(response, destination, {
        'set-cookie': [
          cookie(sessionCookieName, redeemed.sessionToken, { httpOnly: true, maxAge: 30 * 24 * 60 * 60 }),
          cookie('gameplan_csrf', redeemed.csrfToken, { sameSite: 'Strict', maxAge: 30 * 24 * 60 * 60 }),
        ],
      });
    }

    if (request.method === 'GET' && url.pathname === '/oauth/authorize') {
      const client = findOAuthClient(url.searchParams.get('client_id'));
      const state = url.searchParams.get('state');
      if (!client || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('redirect_uri') !== client.redirectUri) return json(response, 400, { error: 'invalid_request' });
      const authenticated = await requireSession(request, response, { respond: false });
      if (!authenticated) return redirect(response, oauthDeniedRedirect(client, state));
      try { await bot.guildMember(authenticated.session.guild_id, authenticated.session.discord_user_id); } catch { return redirect(response, oauthDeniedRedirect(client, state)); }
      const code = await identity.issueOAuthAuthorizationCode({ session: authenticated.session, clientId: client.id, redirectUri: client.redirectUri });
      if (!code) return redirect(response, oauthDeniedRedirect(client, state));
      const callback = new URL(client.redirectUri);
      callback.searchParams.set('code', code);
      if (state) callback.searchParams.set('state', state);
      return redirect(response, callback.toString());
    }

    if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/oauth/token') {
      // Fider's custom OAuth provider exchanges its authorization code with a
      // query-string GET. Keep standard form POST support for other clients.
      const form = request.method === 'GET' ? url.searchParams : await readForm(request);
      const credentials = oauthClientCredentials(request, form);
      const client = findOAuthClient(credentials.clientId);
      if (!client || client.secret !== credentials.clientSecret || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== client.redirectUri) return json(response, 401, { error: 'invalid_client' });
      const exchanged = await identity.redeemOAuthAuthorizationCode({ code: form.get('code'), clientId: client.id, redirectUri: client.redirectUri });
      if (!exchanged) return json(response, 400, { error: 'invalid_grant' });
      return json(response, 200, { access_token: exchanged.token, token_type: 'Bearer', expires_in: Math.floor((exchanged.expiresAt.getTime() - Date.now()) / 1000) });
    }

    if (request.method === 'GET' && url.pathname === '/oauth/userinfo') {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const profile = await identity.getOAuthProfile(token);
      if (!profile) return json(response, 401, { error: 'invalid_token' });
      return json(response, 200, { sub: `discord:${profile.discord_user_id}`, name: profile.display_name || `Discord user ${profile.discord_user_id}`, email: `discord-${profile.discord_user_id}@users.gameplan.invalid`, roles: ['gameplan_member'] });
    }

    if (request.method === 'GET' && url.pathname === '/api/me') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      const profile = await identity.getProfile(authenticated.session.discord_user_id);
      return json(response, 200, {
        discordUser: { id: profile.discord_user_id, displayName: profile.display_name },
        feedbackUrl: config.feedbackUrl, feedbackNotificationsEnabled: Boolean(config.feedbackUrl && config.feedbackWebhookSecret),
        steamConnection: profile.steam_id ? {
          steamId: profile.steam_id,
          linkedAt: profile.linked_at,
          lastSyncAt: profile.last_sync_at,
          lastSyncStatus: profile.last_sync_status,
          lastSyncError: profile.last_sync_error,
          lastSyncGameCount: profile.last_sync_game_count,
        } : null,
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/planner') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      const members = await planner.getPlanner(authenticated.session.guild_id, authenticated.session.discord_user_id);
      return json(response, 200, { guildId: authenticated.session.guild_id, members });
    }

    if (request.method === 'GET' && url.pathname === '/api/group') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to view its group.' });
      return json(response, 200, { guildId: authenticated.session.guild_id, ...(await planner.getGroup(authenticated.session.guild_id, authenticated.session.discord_user_id)) });
    }

    if (request.method === 'GET' && url.pathname === '/api/notifications') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to configure notifications.' });
      return json(response, 200, await notifications.getSettings({ guildId: authenticated.session.guild_id, discordUserId: authenticated.session.discord_user_id }));
    }

    if (request.method === 'PUT' && url.pathname === '/api/notifications') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to configure notifications.' });
      const body = await readJson(request);
      return json(response, 200, await notifications.saveSettings({ guildId: authenticated.session.guild_id, discordUserId: authenticated.session.discord_user_id, ...body }));
    }

    if (request.method === 'GET' && url.pathname === '/api/feedback-notifications') {
      const authenticated = await requireSession(request, response); if (!authenticated) return;
      if (!config.feedbackUrl || !config.feedbackWebhookSecret) return json(response, 404, { error: 'Feedback notifications are not configured.' });
      return json(response, 200, await feedbackNotifications.getSettings(authenticated.session.discord_user_id));
    }
    if (request.method === 'PUT' && url.pathname === '/api/feedback-notifications') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      if (!config.feedbackUrl || !config.feedbackWebhookSecret) return json(response, 404, { error: 'Feedback notifications are not configured.' });
      return json(response, 200, await feedbackNotifications.saveSettings(authenticated.session.discord_user_id, await readJson(request)));
    }
    if (request.method === 'POST' && url.pathname === '/webhooks/fider') {
      if (!config.feedbackWebhookSecret || request.headers.authorization !== `Bearer ${config.feedbackWebhookSecret}`) return json(response, 401, { error: 'unauthorized' });
      try { return json(response, 202, await feedbackNotifications.receive(await readJson(request))); } catch (error) { return json(response, 400, { error: error.message }); }
    }

    const muteMatch = /^\/api\/notifications\/mutes\/(\d+)$/.exec(url.pathname);
    if (muteMatch && request.method === 'POST') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      return json(response, 200, await notifications.muteGame({ guildId: authenticated.session.guild_id, discordUserId: authenticated.session.discord_user_id, appId: Number(muteMatch[1]) }));
    }
    if (muteMatch && request.method === 'DELETE') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      return json(response, 200, await notifications.unmuteGame({ guildId: authenticated.session.guild_id, discordUserId: authenticated.session.discord_user_id, appId: Number(muteMatch[1]) }));
    }

    if (request.method === 'POST' && url.pathname === '/api/shared-games') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      const result = await planner.partyState(authenticated.session.guild_id, authenticated.session.discord_user_id, body.party);
      return json(response, 200, result);
    }

    if (request.method === 'POST' && url.pathname === '/api/game-rules') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to configure a game.' });
      const body = await readJson(request);
      return json(response, 201, await planner.saveGuildGameRule({
        guildId: authenticated.session.guild_id,
        steamAppId: Number(body.appId),
        gameName: body.gameName,
        minPlayers: Number(body.minPlayers),
        maxPlayers: Number(body.maxPlayers),
        requiresAllOwners: body.requiresAllOwners !== false,
        configuredByDiscordUserId: authenticated.session.discord_user_id,
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/game-rules') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      return json(response, 200, { rules: await planner.listGuildGameRules(authenticated.session.guild_id) });
    }

    if (request.method === 'GET' && url.pathname === '/api/game-settings') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to manage game settings.' });
      return json(response, 200, { games: await planner.listGuildGameSettings(authenticated.session.guild_id) });
    }

    const gameSettingMatch = /^\/api\/game-settings\/(\d+)$/.exec(url.pathname);
    if (gameSettingMatch && request.method === 'PUT') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to manage game settings.' });
      const body = await readJson(request);
      return json(response, 200, await planner.saveGuildGameRule({
        guildId: authenticated.session.guild_id,
        steamAppId: Number(gameSettingMatch[1]),
        gameName: body.gameName,
        minPlayers: Number(body.minPlayers),
        maxPlayers: Number(body.maxPlayers),
        requiresAllOwners: body.requiresAllOwners !== false,
        configuredByDiscordUserId: authenticated.session.discord_user_id,
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      const session = await planner.createSession({
        guildId: authenticated.session.guild_id,
        hostDiscordUserId: authenticated.session.discord_user_id,
        party: body.party,
        appId: body.appId,
        startsAt: body.startsAt,
        hostNote: body.hostNote ?? '',
      });
      await sendInvites(session);
      return json(response, 201, { session, publication: await publishSessionToFeed(session) });
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      return json(response, 200, { sessions: await planner.listSessions(authenticated.session.guild_id, authenticated.session.discord_user_id) });
    }
    const replanMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/replan$/.exec(url.pathname);
    if (replanMatch && request.method === 'GET') {
      const authenticated = await requireSession(request, response); if (!authenticated) return;
      return json(response, 200, await planner.replanOptions({ sessionId: replanMatch[1], hostDiscordUserId: authenticated.session.discord_user_id }));
    }
    const replacementMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/games-tonight\/([0-9a-f-]{36})\/replacement$/.exec(url.pathname);
    if (replacementMatch && request.method === 'POST') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      const body = await readJson(request);
      const result = await planner.replaceGameTonight({ sessionId: replacementMatch[1], gameId: replacementMatch[2], hostDiscordUserId: authenticated.session.discord_user_id, audience: body.audience, appId: Number(body.appId) });
      await announceGameTonightChange({ sessionId: replacementMatch[1], actorDiscordUserId: authenticated.session.discord_user_id, content: `Games Tonight changed: **${result.replacement.title}** replaces **${result.replaced.title}** for ${result.audience.label.toLowerCase()}.`, changeKey: `replacement:${result.replaced.id}:${result.replacement.appId}:${result.audience.key}` });
      return json(response, 200, { games: result.games });
    }
    const gamesTonightPlayersMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/games-tonight\/([0-9a-f-]{36})\/players$/.exec(url.pathname);
    if (gamesTonightPlayersMatch && request.method === 'PUT') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      const body = await readJson(request);
      const games = await planner.setGameTonightPlayers({ sessionId: gamesTonightPlayersMatch[1], gameId: gamesTonightPlayersMatch[2], hostDiscordUserId: authenticated.session.discord_user_id, playerIds: body.playerIds });
      const session = await planner.getSession(gamesTonightPlayersMatch[1], authenticated.session.discord_user_id); const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [gamesTonightPlayersMatch[1]]);
      try { await updateLfgCard({ session, post, bot }); } catch (error) { console.warn(`Could not update GamePlan Session Feed card after changing expected players: ${error.message}`); }
      return json(response, 200, { games });
    }
    const gamesTonightMatch = /^\/api\/sessions\/([0-9a-f-]{36})\/games-tonight(?:\/([0-9a-f-]{36}))?$/.exec(url.pathname);
    if (gamesTonightMatch && request.method === 'GET') {
      const authenticated = await requireSession(request, response); if (!authenticated) return;
      const games = await planner.listGamesTonight(gamesTonightMatch[1], authenticated.session.discord_user_id);
      return games ? json(response, 200, { games }) : json(response, 404, { error: 'Game Night not found' });
    }
    if (gamesTonightMatch && !gamesTonightMatch[2] && request.method === 'POST') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      const body = await readJson(request);
      const games = await planner.addGameTonight({ sessionId: gamesTonightMatch[1], hostDiscordUserId: authenticated.session.discord_user_id, appId: Number(body.appId), title: body.title, note: body.note ?? '', playerIds: body.playerIds ?? null });
      const session = await planner.getSession(gamesTonightMatch[1], authenticated.session.discord_user_id); const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [gamesTonightMatch[1]]);
      try { await updateLfgCard({ session, post, bot }); } catch (error) { console.warn(`Could not update GamePlan Session Feed card after adding a game: ${error.message}`); }
      return json(response, 201, { games });
    }
    if (gamesTonightMatch && gamesTonightMatch[2] && request.method === 'PATCH') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      const body = await readJson(request);
      const games = await planner.updateGameTonight({ sessionId: gamesTonightMatch[1], gameId: gamesTonightMatch[2], hostDiscordUserId: authenticated.session.discord_user_id, status: body.status, note: body.note ?? '' });
      const changed = games.find((game) => game.id === gamesTonightMatch[2]); const nowPlaying = games.find((game) => game.status === 'now_playing');
      await announceGameTonightChange({ sessionId: gamesTonightMatch[1], actorDiscordUserId: authenticated.session.discord_user_id, content: `Games Tonight changed: **${changed.title}** is ${changed.status.replaceAll('_', ' ')}.${nowPlaying && nowPlaying.id !== changed.id ? ` Now playing: **${nowPlaying.title}**.` : ''}`, changeKey: `status:${changed.id}:${changed.status}` });
      return json(response, 200, { games });
    }
    if (gamesTonightMatch && gamesTonightMatch[2] && request.method === 'DELETE') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      const games = await planner.removeGameTonight({ sessionId: gamesTonightMatch[1], gameId: gamesTonightMatch[2], hostDiscordUserId: authenticated.session.discord_user_id });
      const session = await planner.getSession(gamesTonightMatch[1], authenticated.session.discord_user_id); const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [gamesTonightMatch[1]]);
      try { await updateLfgCard({ session, post, bot }); } catch (error) { console.warn(`Could not update GamePlan Session Feed card after removing a game: ${error.message}`); }
      return json(response, 200, { games });
    }
    if (gamesTonightMatch && gamesTonightMatch[2] && request.method === 'PUT') {
      const authenticated = await requireSession(request, response, { csrf: true }); if (!authenticated) return;
      const body = await readJson(request);
      const games = await planner.reorderGameTonight({ sessionId: gamesTonightMatch[1], gameId: gamesTonightMatch[2], hostDiscordUserId: authenticated.session.discord_user_id, position: Number(body.position) });
      const session = await planner.getSession(gamesTonightMatch[1], authenticated.session.discord_user_id); const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [gamesTonightMatch[1]]);
      try { await updateLfgCard({ session, post, bot }); } catch (error) { console.warn(`Could not update GamePlan Session Feed card after reordering games: ${error.message}`); }
      return json(response, 200, { games });
    }

    if (request.method === 'GET' && url.pathname === '/api/regular-game-nights') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to view regular Game Nights.' });
      return json(response, 200, {
        gameNights: await planner.listRegularGameNights(authenticated.session.guild_id, authenticated.session.discord_user_id),
        eligibleGameNights: await planner.listHostedUpcomingSessions(authenticated.session.guild_id, authenticated.session.discord_user_id),
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/regular-game-nights') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      return json(response, 201, { gameNight: await planner.createRegularGameNight({
        guildId: authenticated.session.guild_id,
        hostDiscordUserId: authenticated.session.discord_user_id,
        sourceSessionId: body.sourceSessionId,
        cadence: body.cadence,
      }) });
    }
    const regularGameNightMatch = /^\/api\/regular-game-nights\/([0-9a-f-]{36})$/.exec(url.pathname);
    if (regularGameNightMatch && request.method === 'PATCH') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      return json(response, 200, { gameNight: await planner.updateRegularGameNight({ id: regularGameNightMatch[1], hostDiscordUserId: authenticated.session.discord_user_id, cadence: body.cadence, active: body.active }) });
    }

    if (request.method === 'GET' && (url.pathname === '/api/session-feed' || url.pathname === '/api/lfg-channels')) {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server first.' });
      const policy = await guildPolicy.get(authenticated.session.guild_id);
      const channels = await bot.sendableTextChannels(authenticated.session.guild_id);
      return json(response, 200, { defaultChannelId: policy.defaultLfgChannelId, channels: channels.filter((channel) => policy.allowedChannelIds.includes(channel.id)).map(({ id, name }) => ({ id, name })) });
    }

    if (request.method === 'PUT' && url.pathname === '/api/session-feed') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      if (!authenticated.session.guild_id) return json(response, 409, { error: 'Open GamePlan from a Discord server to configure the Session Feed.' });
      const body = await readJson(request);
      if (!body.channelId) return json(response, 400, { error: 'Choose a Session Feed channel.' });
      const channels = await bot.sendableTextChannels(authenticated.session.guild_id);
      if (!channels.some((channel) => channel.id === body.channelId)) return json(response, 400, { error: 'GamePlan cannot view and post to that channel.' });
      return json(response, 200, await guildPolicy.addAllowedChannel({ guildId: authenticated.session.guild_id, channelId: body.channelId, actorId: authenticated.session.discord_user_id, makeDefault: true }));
    }

    const sessionMatch = /^\/api\/sessions\/([0-9a-f-]{36})(?:\/(rsvp|publish|live-status))?$/.exec(url.pathname);
    if (sessionMatch && request.method === 'GET' && !sessionMatch[2]) {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      const session = await planner.getSession(sessionMatch[1], authenticated.session.discord_user_id);
      return session ? json(response, 200, { session }) : json(response, 404, { error: 'session not found' });
    }
    if (sessionMatch && request.method === 'PATCH' && !sessionMatch[2]) {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      const session = await planner.updateSession({ id: sessionMatch[1], hostDiscordUserId: authenticated.session.discord_user_id, startsAt: body.startsAt, hostNote: body.hostNote ?? '' });
      const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [session.id]);
      try { await updateLfgCard({ session, post, bot }); } catch (error) { console.warn(`Could not update GamePlan Session Feed card after an edit: ${error.message}`); }
      return json(response, 200, { session });
    }
    if (sessionMatch && request.method === 'POST' && sessionMatch[2] === 'rsvp') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      const session = await planner.respondToSession({ id: sessionMatch[1], discordUserId: authenticated.session.discord_user_id, response: body.response });
      return json(response, 200, { session });
    }
    if (sessionMatch && request.method === 'PATCH' && url.pathname === `/api/sessions/${sessionMatch[1]}/live-status`) {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const body = await readJson(request);
      return json(response, 200, { session: await planner.updateLiveStatus({ id: sessionMatch[1], actorDiscordUserId: authenticated.session.discord_user_id, discordUserId: body.discordUserId, status: body.status }) });
    }

    if (sessionMatch && request.method === 'POST' && url.pathname === `/api/sessions/${sessionMatch[1]}/publish`) {
      return json(response, 410, { error: 'Sessions now publish automatically to the server Session Feed when they are created.' });
    }

    if (request.method === 'POST' && url.pathname === '/api/steam/start') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const attempt = await identity.createSteamLinkAttempt(authenticated.session.discord_user_id);
      return json(response, 200, { url: createSteamOpenIdRedirect({ publicBaseUrl: config.publicBaseUrl, state: attempt.state }) });
    }

    if (request.method === 'GET' && url.pathname === '/auth/steam/callback') {
      const authenticated = await requireSession(request, response);
      if (!authenticated) return;
      const state = url.searchParams.get('state');
      if (!state || !await identity.consumeSteamLinkAttempt(state, authenticated.session.discord_user_id)) {
        return redirect(response, '/?steam=expired');
      }
      try {
        const { steamId } = await verifySteamOpenIdCallback(url.searchParams);
        await identity.saveSteamConnection(authenticated.session.discord_user_id, steamId);
        const connection = await identity.getProfile(authenticated.session.discord_user_id);
        await syncSteamLibrary(authenticated.session.discord_user_id, connection);
        return redirect(response, '/?steam=linked');
      } catch (error) {
        return redirect(response, `/?steam=error&message=${encodeURIComponent(error.message)}`);
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/steam/sync') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      const profile = await identity.getProfile(authenticated.session.discord_user_id);
      if (!profile?.steam_id) return json(response, 409, { error: 'Link Steam before syncing.' });
      try {
        return json(response, 200, await syncSteamLibrary(authenticated.session.discord_user_id, profile));
      } catch (error) {
        return json(response, 502, { error: `Steam sync failed: ${error.message}` });
      }
    }

    if (request.method === 'DELETE' && url.pathname === '/api/steam/connection') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      await identity.removeSteamConnection(authenticated.session.discord_user_id);
      return json(response, 200, { deleted: true });
    }

    if (request.method === 'DELETE' && url.pathname === '/api/me') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      await identity.deleteDiscordUser(authenticated.session.discord_user_id);
      await identity.revokeBrowserSession(authenticated.sessionToken);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'set-cookie': clearCookies() });
      return response.end(JSON.stringify({ deleted: true }));
    }

    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const authenticated = await requireSession(request, response, { csrf: true });
      if (!authenticated) return;
      await identity.revokeBrowserSession(authenticated.sessionToken);
      response.writeHead(204, { 'set-cookie': clearCookies(), 'cache-control': 'no-store' });
      return response.end();
    }

    if (request.method === 'POST' && url.pathname === '/discord/interactions') {
      const rawBody = await readBody(request);
      const valid = verifyDiscordSignature({
        publicKey: config.discordPublicKey,
        signature: request.headers['x-signature-ed25519'],
        timestamp: request.headers['x-signature-timestamp'],
        rawBody,
      });
      if (!valid) return json(response, 401, { error: 'invalid Discord interaction signature' });
      const interaction = JSON.parse(rawBody);
      const traceId = randomUUID();
      const command = interaction.data?.name ?? interaction.data?.custom_id ?? `type-${interaction.type}`;
      const initialResponse = interaction.type === 1 ? { type: 1 } : interaction.type === 2 ? deferredInteractionResponse() : null;
      await trace({ traceId, direction: 'inbound', eventType: 'discord-interaction', interactionId: interaction.id, command, requestBody: interaction, responseBody: initialResponse, responseText: rawBody.toString(), method: request.method, path: url.pathname });
      if (interaction.type === 1) return json(response, 200, initialResponse);
      const actor = discordIdentity(interaction);
      if (!actor) return json(response, 400, { error: 'Discord interaction did not include a user' });
      const dependencies = { interaction, actor, identity, guildPolicy, bot, planner, rallies, database, flows, notifications, feedbackNotifications: config.feedbackUrl && config.feedbackWebhookSecret ? feedbackNotifications : null, syncSteamLibrary, sendInvites, publishSessionToFeed, issueBrowserUrl, feedbackUrl: config.feedbackUrl };
      if (interaction.type === 2) {
        json(response, 200, initialResponse);
        void discordTraceContext.run(traceId, async () => {
          let result;
          try {
            result = await handleDiscordInteraction(dependencies);
          } catch (error) {
            console.error('[discord-interaction] handler failed', { command, error: error instanceof Error ? error.stack : error });
            result = ephemeral('GamePlan could not complete that command. Please try again.');
          }
          try {
            const data = result?.data ?? ephemeral('GamePlan could not prepare a response.').data;
            const browserUrl = allowsBrowserAlternative(interaction) && data.flags === 64 && !data.components?.some((row) => row.components?.some((component) => component.style === 5 && component.url)) ? await issueBrowserUrl(actor) : null;
            await bot.editInteractionResponse(interaction, prepareDiscordMessage(data, browserUrl));
          } catch (error) {
            console.error('[discord-interaction] response edit failed', { command, error: error instanceof Error ? error.stack : error });
          }
        });
        return;
      }
      const result = await handleDiscordInteraction(dependencies);
      const browserUrl = allowsBrowserAlternative(interaction) && result?.data?.flags === 64 && !result.data.components?.some((row) => row.components?.some((component) => component.style === 5 && component.url)) ? await issueBrowserUrl(actor) : null;
      const prepared = result?.data ? { ...result, data: prepareDiscordMessage(result.data, browserUrl) } : result;
      await trace({ traceId, direction: 'outbound', eventType: 'discord-interaction-response', interactionId: interaction.id, command, method: 'POST', path: url.pathname, status: 200, responseBody: prepared });
      return json(response, 200, prepared);
    }

    return json(response, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: 'internal server error' });
  }
});

server.listen(config.port, () => {
  console.log(`GamePlan listening on :${config.port}`);
  memberSync?.start();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    memberSync?.stop();
    server.close(() => database.close().finally(() => process.exit(0)));
  });
}

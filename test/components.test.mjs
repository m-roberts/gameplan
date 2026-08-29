import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { browserLinkResponse, deferredInteractionResponse, discordIdentity, helpResponse, interactionResponse, onboardingCard, prepareDiscordMessage, setupResponse, verifyDiscordSignature } from '../src/discord.mjs';
import { DiscordBot } from '../src/discord-bot.mjs';
import { IdentityService } from '../src/identity.mjs';
import { fetchOwnedGames } from '../src/steam.mjs';
import { createSteamOpenIdRedirect, verifySteamOpenIdCallback } from '../src/steam-openid.mjs';
import { cancelledLfgCard, inviteCard, lfgCard } from '../src/discord-bot.mjs';
import { discussionOpening, lfgThreadName, sessionActivity } from '../src/lfg-discussion.mjs';

test('validates Discord Ed25519 signatures over timestamp plus raw body', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const timestamp = '1724371200';
  const rawBody = Buffer.from('{"type":1}');
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex');

  assert.equal(verifyDiscordSignature({ publicKey: rawPublicKey, signature, timestamp, rawBody }), true);
  assert.equal(verifyDiscordSignature({ publicKey: rawPublicKey, signature, timestamp, rawBody: Buffer.from('{}') }), false);
});

test('issues a private browser URL response from an immutable Discord user', () => {
  const interaction = { type: 2, guild_id: 'guild-1', member: { user: { id: 'discord-1', username: 'Rally' } }, data: { name: 'gameplan' } };
  assert.deepEqual(discordIdentity(interaction), { discordUserId: 'discord-1', displayName: 'Rally', guildId: 'guild-1', guildPermissions: null, guildRoleIds: [] });
  const response = interactionResponse(interaction, { browserUrl: 'https://rally.example/launch/token' });
  assert.equal(response.data.flags, 64);
  assert.equal(response.data.components[0].components[0].style, 5);
  assert.equal(response.data.components[0].components[0].url, 'https://rally.example/launch/token');
});

test('public onboarding does not expose a browser link, while follow-up links are ephemeral', () => {
  const publicCard = onboardingCard();
  assert.equal(publicCard.data.flags, undefined);
  assert.equal(publicCard.data.components[0].components.every((component) => !component.url), true);
  assert.deepEqual(publicCard.data.components[0].components.map((component) => component.custom_id), ['onboard:start', 'onboard:help']);

  const privateLink = browserLinkResponse('Open your private link.', 'https://rally.example/launch/opaque-token');
  assert.equal(privateLink.data.flags, 64);
  assert.equal(privateLink.data.components[0].components[0].url, 'https://rally.example/launch/opaque-token');
  assert.equal(helpResponse().data.flags, 64);
});

test('slash commands can be acknowledged before their deferred response is ready', async () => {
  assert.deepEqual(deferredInteractionResponse(), { type: 5, data: { flags: 64 } });
  let request;
  const bot = new DiscordBot({ token: 'bot-token', fetchImpl: async (url, options) => {
    request = { url, options };
    return new Response(null, { status: 204 });
  } });
  await bot.editInteractionResponse({ application_id: 'app-1', token: 'interaction-token' }, { flags: 64, content: 'Ready.' });
  assert.equal(request.url, 'https://discord.com/api/v10/webhooks/app-1/interaction-token/messages/@original');
  assert.equal(request.options.method, 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), { content: 'Ready.' });
});

test('deferred responses stay within Discord’s content limit', async () => {
  let request;
  const bot = new DiscordBot({ token: 'bot-token', fetchImpl: async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(null, { status: 204 });
  } });
  await bot.editInteractionResponse({ application_id: 'app-1', token: 'interaction-token' }, { content: 'x'.repeat(2500) });
  assert.equal(request.content.length, 2000);
  assert.match(request.content, /Truncated.*web UI/);
});

test('oversized ephemeral responses explain truncation and offer the web UI', () => {
  const response = prepareDiscordMessage({ flags: 64, content: 'x'.repeat(2500) }, 'https://rally.example/launch/token');
  assert.equal(response.content.length, 2000);
  assert.match(response.content, /Truncated.*Open GamePlan/);
  assert.equal(response.components.at(-1).components[0].url, 'https://rally.example/launch/token');
});

test('invitation and published-session cards explain the available actions', () => {
  const session = {
    id: 'session-1',
    browserUrl: 'https://rally.example/launch/opaque-token',
    game: { title: 'Deep Rock Galactic' },
    startsAt: '2030-01-01T20:00:00.000Z',
    hostNote: 'Bring snacks.',
    rsvps: [{ displayName: 'Rally', response: 'accepted' }],
  };
  const invitation = inviteCard(session);
  assert.equal(invitation.content, 'You’re invited to a GamePlan session.');
  assert.deepEqual(invitation.components[0].components.map((component) => component.label), ['Accept', 'Decline', 'Details', 'How it works']);

  session.guildId = 'guild-1'; session.hostDiscordUserId = 'discord-1'; session.game.maxPlayers = 4; session.rsvps[0].discordUserId = 'discord-1';
  const lfg = lfgCard(session, { discussionThreadId: 'thread-1' });
  assert.match(lfg.embeds[0].description, /link Steam and sync a visible library/);
  assert.match(lfg.embeds[0].fields.find((field) => field.name === 'Roster').value, /1\/4 confirmed.*3 slots left/);
  assert.match(lfg.embeds[0].fields.find((field) => field.name === 'Controls').value, /Join.*Leave/);
  assert.deepEqual(lfg.components[0].components.map((component) => component.label), ['Join session', 'Leave session', 'Transfer Host', 'Cancel session', 'Open discussion']);
  assert.match(lfg.components[0].components[4].url, /discord\.com\/channels\/guild-1\/thread-1/);

  session.rsvps = Array.from({ length: 4 }, (_, index) => ({
    discordUserId: `discord-${index + 1}`,
    displayName: `Player ${index + 1}`,
    response: 'accepted',
  }));
  const full = lfgCard(session, { discussionThreadId: 'thread-1' });
  assert.equal(full.components[0].components[0].disabled, true);
  assert.match(full.embeds[0].fields.find((field) => field.name === 'Roster').value, /4\/4 confirmed.*0 slots left/);

  const cancelled = cancelledLfgCard(session, { cancellationReason: 'Not enough players tonight' });
  assert.match(cancelled.embeds[0].title, /Cancelled.*Deep Rock Galactic/);
  assert.match(cancelled.embeds[0].description, /Not enough players tonight/);
  assert.match(cancelled.embeds[0].fields.find((field) => field.name === 'Original roster').value, /Player 1/);
  assert.deepEqual(cancelled.components, []);
});

test('setup controls use Discord-valid Action Rows', () => {
  const response = setupResponse({ defaultLfgChannelId: null, allowedChannelIds: [], coordinatorRoleIds: [] });
  assert.ok(response.data.components.length <= 5);
  for (const row of response.data.components) {
    const hasSelect = row.components.some((component) => [3, 5, 6, 7, 8].includes(component.type));
    assert.ok(!hasSelect || row.components.length === 1, 'a Discord select menu must occupy its own Action Row');
  }
});

test('discussion activity uses explicit affected-user mentions rather than @here', () => {
  const session = {
    game: { title: 'Deep Rock Galactic' },
    startsAt: '2030-01-01T20:00:00.000Z',
    rsvps: [{ discordUserId: 'discord-1', displayName: 'Rally', response: 'accepted' }],
  };
  const opening = discussionOpening(session);
  assert.match(opening.content, /<@discord-1>/);
  assert.doesNotMatch(opening.content, /@here/);
  assert.deepEqual(opening.allowed_mentions, { parse: [], users: ['discord-1'] });
  assert.deepEqual(sessionActivity({ content: 'Rally joined.', notifyDiscordUserIds: ['discord-1', 'discord-1'] }).allowed_mentions, { parse: [], users: ['discord-1'] });
});

test('Session Feed card and discussion opening use the visible Games Tonight language', () => {
  const session = {
    id: '11111111-1111-1111-1111-111111111111', guildId: 'guild-1', hostNote: null,
    game: { title: 'Main game', maxPlayers: 4, requiresAllOwners: true }, startsAt: '2030-01-01T20:00:00.000Z',
    hostDiscordUserId: 'discord-1', registrationClosedAt: null,
    rsvps: [{ discordUserId: 'discord-1', displayName: 'Rally', response: 'accepted' }],
    gamesTonight: [{ title: 'Warm-up', status: 'now_playing', note: 'While we wait' }, { title: 'Main game', status: 'up_next', note: null }],
  };
  const card = lfgCard(session);
  const games = card.embeds[0].fields.find((field) => field.name === 'Games Tonight');
  assert.match(games.value, /Now playing.*Warm-up/);
  assert.match(games.value, /Up next.*Main game/);
  assert.match(discussionOpening(session).content, /Games Tonight/);
  assert.match(discussionOpening(session).content, /While we wait/);
});

test('session discussion names include the scheduled UK time and a stable unique suffix', () => {
  const first = lfgThreadName({ id: '11111111-1111-1111-1111-111111111111', game: { title: 'R.E.P.O.' }, startsAt: '2030-08-23T19:00:00.000Z' });
  const second = lfgThreadName({ id: '22222222-2222-2222-2222-222222222222', game: { title: 'R.E.P.O.' }, startsAt: '2030-08-30T19:00:00.000Z' });
  assert.match(first, /GamePlan.*R\.E\.P\.O\..*23 Aug.*#111111/);
  assert.match(second, /30 Aug.*#222222/);
  assert.notEqual(first, second);
  assert.ok(first.length <= 100);
});

test('setup asks for one Session Feed, not a Coordinator role or publish permission', () => {
  const response = setupResponse({ defaultLfgChannelId: null, allowedChannelIds: [], coordinatorRoleIds: [] });
  assert.equal(response.data.components.some((row) => row.components.some((component) => component.custom_id === 'setup:add-role')), false);
  assert.equal(response.data.components.filter((row) => row.components.some((component) => component.type === 8)).length, 1);
  assert.match(response.data.content, /Session Feed/);
  assert.match(response.data.content, /published here automatically/);
});

test('Browser Links are opaque, single-use and cannot be replayed', async () => {
  const queries = [];
  let ticketAvailable = true;
  const database = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.startsWith('UPDATE browser_link_tickets')) {
        if (!ticketAvailable) return { rowCount: 0, rows: [] };
        ticketAvailable = false;
        return { rowCount: 1, rows: [{ discord_user_id: 'discord-1' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const service = new IdentityService({ database, appSecret: 'a-safe-test-secret-that-is-long-enough' });
  const issued = await service.issueBrowserLink({ discordUserId: 'discord-1', guildId: 'guild-1' });
  assert.equal(issued.token.includes('discord-1'), false);
  const first = await service.redeemBrowserLink(issued.token);
  assert.equal(first.discordUserId, 'discord-1');
  assert.equal(await service.redeemBrowserLink(issued.token), null);
  assert.match(queries.find(({ sql }) => sql.startsWith('UPDATE browser_link_tickets')).sql, /redeemed_at IS NULL AND expires_at > now/);
});

test('OAuth provider issues one-time authorization codes for current members', async () => {
  const calls = [];
  const database = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT 1 FROM guild_members')) return { rowCount: 1, rows: [{}] };
    if (sql.startsWith('UPDATE oauth_authorization_codes')) return { rowCount: 1, rows: [{ discord_user_id: 'discord-1', guild_id: 'guild-1' }] };
    if (sql.includes('FROM oauth_access_tokens')) return { rowCount: 1, rows: [{ discord_user_id: 'discord-1', display_name: 'Rally' }] };
    return { rowCount: 1, rows: [] };
  } };
  const service = new IdentityService({ database, appSecret: 'a-safe-test-secret-that-is-long-enough' });
  const code = await service.issueOAuthAuthorizationCode({ session: { discord_user_id: 'discord-1', guild_id: 'guild-1' }, clientId: 'client-1', redirectUri: 'https://client.example/callback' });
  const exchanged = await service.redeemOAuthAuthorizationCode({ code, clientId: 'client-1', redirectUri: 'https://client.example/callback' });
  assert.ok(exchanged?.token);
  assert.deepEqual(await service.getOAuthProfile(exchanged.token), { discord_user_id: 'discord-1', display_name: 'Rally' });
  assert.match(calls[1].sql, /oauth_authorization_codes/);
  assert.match(calls[3].sql, /oauth_access_tokens/);
});

test('requests owned games from the public Steam host and distinguishes private libraries', async () => {
  let seenUrl;
  let seenHeaders;
  const result = await fetchOwnedGames({
    apiKey: 'test-key',
    steamId: '76561198049380097',
    fetchImpl: async (url, { headers }) => {
      seenUrl = url;
      seenHeaders = headers;
      return new Response(JSON.stringify({ response: { game_count: 1, games: [{ appid: 620, name: 'Portal 2', playtime_forever: 42 }] } }));
    },
  });
  assert.equal(seenUrl.hostname, 'api.steampowered.com');
  assert.equal(seenHeaders['x-webapi-key'], 'test-key');
  assert.deepEqual(result.games, [{ appId: 620, name: 'Portal 2', playtimeMinutes: 42 }]);
  assert.equal(result.libraryVisible, true);

  const unavailable = await fetchOwnedGames({
    apiKey: 'test-key', steamId: '76561198049380097',
    fetchImpl: async () => new Response(JSON.stringify({ response: {} })),
  });
  assert.equal(unavailable.libraryVisible, false);
  assert.equal(unavailable.gameCount, null);
});

test('Steam OpenID uses a fixed Steam endpoint and verifies the claimed SteamID', async () => {
  const redirect = new URL(createSteamOpenIdRedirect({ publicBaseUrl: 'https://rally.example', state: 'state-token' }));
  assert.equal(redirect.origin, 'https://steamcommunity.com');
  assert.equal(redirect.searchParams.get('openid.return_to'), 'https://rally.example/auth/steam/callback?state=state-token');

  const callback = new URLSearchParams({
    'openid.claimed_id': 'https://steamcommunity.com/openid/id/76561198049380097',
    'openid.identity': 'https://steamcommunity.com/openid/id/76561198049380097',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
  });
  const verified = await verifySteamOpenIdCallback(callback, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://steamcommunity.com/openid/login');
    assert.equal(options.body.get('openid.mode'), 'check_authentication');
    return new Response('is_valid:true\n');
  } });
  assert.equal(verified.steamId, '76561198049380097');
});

test('foundation migration models identities, snapshots and future game sessions', async () => {
  const migration = await readFile(new URL('../migrations/0001_foundation.sql', import.meta.url), 'utf8');
  for (const table of ['discord_users', 'browser_link_tickets', 'browser_sessions', 'steam_connections', 'ownership_snapshots', 'steam_owned_games', 'game_sessions', 'session_rsvps']) {
    assert.match(migration, new RegExp(`CREATE TABLE ${table}`));
  }
  assert.match(migration, /ON DELETE CASCADE/);
});

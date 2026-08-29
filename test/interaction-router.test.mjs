import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDiscordInteraction, londonTimeOptions } from '../src/interaction-router.mjs';
import { command as registeredCommand } from '../src/command-definition.mjs';

const actor = {
  discordUserId: 'discord-1', displayName: 'Rally', guildId: 'guild-1',
  guildPermissions: String(1n << 5n), guildRoleIds: [],
};

function dependencies({ installed = true, allowed = true } = {}) {
  const records = [];
  let policy = { defaultLfgChannelId: null, allowedChannelIds: [], coordinatorRoleIds: [] };
  const flows = { created: [], updated: [], async create(value) { const flow = { id: '11111111-1111-1111-1111-111111111111', ...value }; this.created.push(flow); return flow; }, async get() { return null; }, async update(value) { this.updated.push(value); return value; } };
  return {
    records,
    flows,
    identity: {
      async recordDiscordUser(value) { records.push(value); },
      async getProfile() { return null; },
      async getOwnedGames() { return { page: 1, total: 0, games: [] }; },
    },
    guildPolicy: {
      async isInstalled() { return installed; },
      async allowsChannel() { return allowed; },
      async get() { return policy; },
      async addAllowedChannel({ channelId }) { policy = { ...policy, defaultLfgChannelId: channelId, allowedChannelIds: [...new Set([...policy.allowedChannelIds, channelId])] }; return policy; },
    },
    bot: {
      async sendableTextChannels() { return [{ id: 'channel-1', name: 'game-night' }]; },
      async roles() { return []; },
    },
    planner: { async listSessions() { return []; }, async getPlanner() { return [{ discordUserId: actor.discordUserId, displayName: actor.displayName, steam: { syncStatus: 'complete' } }, { discordUserId: '76561198000000001', displayName: 'Friend', steam: { syncStatus: 'complete' } }]; } },
    database: { async query() { return { rowCount: 0, rows: [] }; } },
    async syncSteamLibrary() { return { status: 'complete', gameCount: 0 }; },
    async sendInvites() {},
    async publishSessionToFeed() { return { published: true, channelId: 'channel-1' }; },
    async issueBrowserUrl() { return 'https://rally.example/launch/opaque-token'; },
  };
}

function command(action, channelId = 'channel-1', group = null) {
  return { type: 2, guild_id: actor.guildId, channel_id: channelId, data: { name: 'gameplan', options: action ? group ? [{ name: group, options: [{ name: action }] }] : [{ name: action }] : [] } };
}

test('Discord exposes a small task-oriented command surface', () => {
  assert.deepEqual(registeredCommand.options.map((option) => option.name), ['start', 'invite', 'server', 'me', 'group', 'games', 'sync', 'sessions', 'regular', 'tonight', 'feedback', 'feedback-notifications', 'notifications', 'help']);
});

test('/gameplan feedback is private and only links when configured', async () => {
  const unavailable = await handleDiscordInteraction({ interaction: command('feedback'), actor, ...dependencies() });
  assert.equal(unavailable.data.flags, 64);
  assert.match(unavailable.data.content, /not configured/);

  const deps = dependencies();
  let continuation = null;
  deps.issueBrowserUrl = async (_actor, options) => {
    continuation = options?.continueTo;
    return 'https://rally.example/launch/opaque-token?continue=https%3A%2F%2Ffeedback.example';
  };
  const response = await handleDiscordInteraction({ interaction: command('feedback'), actor, ...deps, feedbackUrl: 'https://feedback.example' });
  assert.equal(response.data.flags, 64);
  assert.equal(continuation, 'https://feedback.example');
  assert.deepEqual(response.data.components[0].components[0], { type: 2, style: 5, label: 'Share feedback', url: 'https://rally.example/launch/opaque-token?continue=https%3A%2F%2Ffeedback.example' });
});

test('/gameplan feedback-notifications exposes deployment-scoped defaults and controls', async () => {
  const deps = dependencies();
  let saved = null;
  deps.feedbackNotifications = {
    async getSettings() { return { ownerUpdatesEnabled: true, participantUpdatesEnabled: true }; },
    async saveSettings(_id, value) { saved = value; return value; },
  };
  const response = await handleDiscordInteraction({ interaction: command('feedback-notifications'), actor, ...deps, feedbackUrl: 'https://feedback.example' });
  assert.equal(response.data.flags, 64);
  assert.match(response.data.content, /Feedback notifications/);
  assert.equal(response.data.components[0].components[0].custom_id, 'feedback-notify:owner');

  const updated = await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: 'feedback-notify:participant', values: ['off'] } }, actor, ...deps, feedbackUrl: 'https://feedback.example' });
  assert.equal(updated.type, 7);
  assert.equal(saved.participantUpdatesEnabled, false);
});

test('Games Tonight gives a host Discord controls for every multi-game edit', async () => {
  const deps = dependencies();
  const session = { id: '11111111-1111-1111-1111-111111111111', guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, startsAt: '2030-01-01T20:00:00.000Z', game: { title: 'Main game' }, rsvps: [{ discordUserId: actor.discordUserId, displayName: actor.displayName }, { discordUserId: '22222222222222222', displayName: 'Friend' }] };
  const games = [
    { id: '22222222-2222-2222-2222-222222222222', title: 'Warm-up', status: 'up_next', position: 0, note: 'While we wait', playerIds: [actor.discordUserId], compatibility: { playerCount: 1, fitsParty: true } },
    { id: '33333333-3333-3333-3333-333333333333', title: 'Main game', status: 'up_next', position: 1, note: null, playerIds: [actor.discordUserId, '22222222222222222'], compatibility: { playerCount: 2, fitsParty: true } },
  ];
  const calls = [];
  const notifications = { queued: [], async queueGameNightChange(value) { this.queued.push(value); } };
  Object.assign(deps.planner, {
    async listSessions() { return [session]; },
    async getSession() { return session; },
    async listGamesTonight() { return games; },
    async updateGameTonight(value) { calls.push(['update', value]); return games; },
    async reorderGameTonight(value) { calls.push(['reorder', value]); return games; },
    async removeGameTonight(value) { calls.push(['remove', value]); return games; },
    async setGameTonightPlayers(value) { calls.push(['players', value]); return games; },
    async addGameTonight(value) { calls.push(['add', value]); return games; },
    async replanOptions() { return { audiences: [{ key: 'here_now', label: 'People here now', people: [{ displayName: actor.displayName }], alternatives: [{ appId: 1, title: 'Replacement', minPlayers: 1, maxPlayers: 4 }] }], replaceableGames: [{ id: games[1].id, title: games[1].title, status: 'up_next' }] }; },
    async replaceGameTonight(value) { calls.push(['replace', value]); return { games, replacement: { appId: 1, title: 'Replacement' }, replaced: { id: games[1].id, title: games[1].title }, audience: { key: 'here_now', label: 'People here now' } }; },
  });
  const opened = await handleDiscordInteraction({ interaction: command('tonight'), actor, ...deps });
  assert.equal(opened.data.components[0].components[0].custom_id, 'tonight:open');
  const panel = await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: 'tonight:open', values: [session.id] } }, actor, ...deps });
  assert.equal(panel.type, 7);
  assert.equal(panel.data.components[0].components[0].custom_id, `tonight:add:${session.id}`);
  const item = await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: `tonight:game:${session.id}`, values: [games[1].id] } }, actor, ...deps });
  assert.equal(item.data.components[1].components.map((component) => component.custom_id).join(','), `tonight:earlier:${session.id}:${games[1].id},tonight:later:${session.id}:${games[1].id},tonight:note:${session.id}:${games[1].id},tonight:players:${session.id}:${games[1].id},tonight:remove:${session.id}:${games[1].id}`);
  await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: `tonight:status:${session.id}:${games[1].id}`, values: ['now_playing'] } }, actor, ...deps, notifications });
  await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: `tonight:earlier:${session.id}:${games[1].id}` } }, actor, ...deps });
  assert.equal(calls[0][0], 'update');
  assert.equal(calls[0][1].status, 'now_playing');
  assert.match(notifications.queued[0].content, /Games Tonight changed/);
  assert.deepEqual(calls[1], ['reorder', { sessionId: session.id, gameId: games[1].id, hostDiscordUserId: actor.discordUserId, position: 0 }]);
  const add = await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: `tonight:add:${session.id}` } }, actor, ...deps });
  assert.equal(add.type, 9);
  assert.equal(add.data.custom_id, `tonight:add-submit:${session.id}`);
  const replan = await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: `tonight:replan:${session.id}` } }, actor, ...deps });
  assert.match(replan.data.content, /will not change anything/);
  await handleDiscordInteraction({ interaction: { type: 3, data: { custom_id: `tonight:replan-apply:${session.id}`, values: [`here_now|${games[1].id}|1`] } }, actor, ...deps });
  assert.equal(calls.at(-1)[0], 'replace');
});

test('/gameplan start opens the primary planning flow', async () => {
  const response = await handleDiscordInteraction({ interaction: command('start'), actor, ...dependencies() });
  assert.match(response.data.content, /Plan a session/);
  assert.equal(response.data.components[0].components[0].custom_id, 'plan:pick-game');
});

test('legacy planning command aliases are no longer handled', async () => {
  for (const alias of ['party', 'rally', 'now']) {
    const deps = dependencies();
    const response = await handleDiscordInteraction({ interaction: command(alias), actor, ...deps });
  assert.match(response.data.content, /Open GamePlan to link Steam and plan your next game night/);
    assert.doesNotMatch(response.data.content, /starts every game-night flow from/);
  }
});

test('public invite card has no private link and records only the invoking member', async () => {
  const deps = dependencies();
  const response = await handleDiscordInteraction({ interaction: command('invite'), actor, ...deps });
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, undefined);
  assert.equal(response.data.components[0].components.every((component) => !component.url), true);
  assert.equal(deps.records.length, 1);
});

test('public invites can be posted outside LFG channels when the bot can post there', async () => {
  const deps = dependencies({ allowed: false });
  deps.bot.sendableTextChannels = async () => [{ id: 'channel-not-approved', name: 'general' }];
  const response = await handleDiscordInteraction({ interaction: command('invite', 'channel-not-approved'), actor, ...deps });
  assert.equal(response.type, 4);
  assert.equal(response.data.flags, undefined);
  assert.equal(deps.records.length, 1);
});

test('an invite card posted outside LFG can still start its private onboarding flow', async () => {
  const deps = dependencies({ allowed: false });
  deps.bot.sendableTextChannels = async () => [{ id: 'channel-not-approved', name: 'general' }];
  const interaction = { type: 3, guild_id: actor.guildId, channel_id: 'channel-not-approved', data: { custom_id: 'onboard:start' } };
  const response = await handleDiscordInteraction({ interaction, actor, ...deps });
  assert.equal(response.data.flags, 64);
  assert.equal(response.data.components[0].components[0].url, 'https://rally.example/launch/opaque-token');
});

test('help is private guidance available in any channel without writes', async () => {
  const deps = dependencies({ installed: false, allowed: false });
  const response = await handleDiscordInteraction({ interaction: command('help', 'channel-not-approved'), actor, ...deps });
  assert.equal(response.data.flags, 64);
  assert.match(response.data.content, /\/gameplan me/);
  assert.match(response.data.content, /\/gameplan start/);
  assert.match(response.data.content, /Link Steam/);
  assert.equal(deps.records.length, 0);
});

test('notifications are a private Discord-first settings panel', async () => {
  const deps = dependencies();
  const settings = { timezone: 'Europe/London', quietStart: null, quietEnd: null, reminderDelivery: 'off', reminderLeadMinutes: [60], lfgAlertDelivery: 'off', mutedGames: [] };
  deps.notifications = { async getSettings() { return settings; } };
  const response = await handleDiscordInteraction({ interaction: command('notifications', 'channel-1', 'manage'), actor, ...deps });
  assert.equal(response.data.flags, 64);
  assert.match(response.data.content, /GamePlan notifications/);
  assert.equal(response.data.components[0].components[0].custom_id, 'notify:reminder-delivery');
});

test('game settings keeps quick Discord edits and offers the full browser editor', async () => {
  const deps = dependencies();
  deps.planner.listGuildGameRules = async () => [{ steam_app_id: 999999, game_name: 'Solo Test Game', min_players: 1, max_players: 1, requires_all_owners: true }];
  const response = await handleDiscordInteraction({ interaction: command('game-settings', 'channel-1', 'manage'), actor, ...deps });
  assert.equal(response.data.flags, 64);
  assert.match(response.data.content, /Game settings/);
  assert.equal(response.data.components[0].components[0].custom_id, 'rules:edit');
  assert.equal(response.data.components.at(-1).components[0].label, 'Open game settings');
  assert.equal(response.data.components.at(-1).components[0].url, 'https://rally.example/launch/opaque-token');
});

test('setup no longer exposes Coordinator-role controls', async () => {
  const deps = dependencies();
  const response = await handleDiscordInteraction({ interaction: command('setup', 'channel-1', 'manage'), actor, ...deps });
  assert.equal(response.data.components.some((row) => row.components.some((component) => component.custom_id === 'setup:add-role')), false);
  assert.match(response.data.content, /Session Feed/);
});

test('setup does not need Discord role lookup', async () => {
  const deps = dependencies();
  deps.bot.roles = async () => { throw new Error('Discord API unavailable'); };
  const response = await handleDiscordInteraction({ interaction: command('setup', 'channel-1', 'manage'), actor, ...deps });
  assert.equal(response.data.flags, 64);
  assert.equal(response.data.components.some((row) => row.components.some((component) => component.custom_id === 'setup:add-role')), false);
  assert.match(response.data.content, /Session Feed/);
});

test('setup edits replace the original private panel rather than creating a noisy new reply', async () => {
  const deps = dependencies();
  const interaction = { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', data: { custom_id: 'setup:default-channel', values: ['channel-1'] } };
  const response = await handleDiscordInteraction({ interaction, actor, ...deps });
  assert.equal(response.type, 7);
  assert.match(response.data.content, /Changes take effect immediately/);
});

test('Done requires a Session Feed then replaces the setup panel with one clear private confirmation', async () => {
  const deps = dependencies();
  const incomplete = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', data: { custom_id: 'setup:done' } }, actor, ...deps });
  assert.equal(incomplete.data.flags, 64);
  assert.match(incomplete.data.content, /Choose a \*\*Session Feed\*\*/);
  await deps.guildPolicy.addAllowedChannel({ channelId: 'channel-1' });
  const response = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', data: { custom_id: 'setup:done' } }, actor, ...deps });
  assert.equal(response.type, 7);
  assert.match(response.data.content, /setup saved/);
  assert.deepEqual(response.data.components, []);
});

test('each onboard click receives an ephemeral private Browser Link', async () => {
  const deps = dependencies();
  const interaction = { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', data: { custom_id: 'onboard:start' } };
  const response = await handleDiscordInteraction({ interaction, actor, ...deps });
  assert.equal(response.data.flags, 64);
  assert.equal(response.data.components[0].components[0].url, 'https://rally.example/launch/opaque-token');
  assert.equal(deps.records.length, 1);
});

test('non-admin setup and cross-guild LFG controls are denied without writes', async () => {
  const deps = dependencies();
  const member = { ...actor, guildPermissions: '0' };
  const setup = await handleDiscordInteraction({ interaction: command('setup', 'channel-1', 'manage'), actor: member, ...deps });
  assert.equal(setup.data.flags, 64);
  assert.equal(deps.records.length, 0);

  const lfg = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: 'guild-other', channel_id: 'channel-1', message: { id: 'message-1' }, data: { custom_id: 'lfg:11111111-1111-1111-1111-111111111111:join' } },
    actor: { ...actor, guildId: 'guild-other' }, ...deps,
  });
  assert.equal(lfg.data.flags, 64);
  assert.match(lfg.data.content, /not valid in this server/);
  assert.equal(deps.records.length, 0);
});

test('library and sync are private Discord-first commands after Steam is linked', async () => {
  const deps = dependencies();
  deps.identity.getProfile = async () => ({ steam_id: '76561198000000000', last_sync_status: 'complete', last_sync_game_count: 2 });
  deps.identity.getOwnedGames = async () => ({ page: 1, total: 2, games: [{ name: 'Deep Rock Galactic' }, { name: 'Helldivers 2' }] });
  const library = await handleDiscordInteraction({ interaction: command('library', 'channel-1', 'steam'), actor, ...deps });
  assert.equal(library.data.flags, 64);
  assert.match(library.data.content, /Deep Rock Galactic/);
  const sync = await handleDiscordInteraction({ interaction: command('sync', 'channel-1', 'steam'), actor, ...deps });
  assert.equal(sync.data.flags, 64);
  assert.match(sync.data.content, /\*\*0 games\*\* are ready/);
});

test('Pick a game starts from the plan chooser, then stays private through session creation', async () => {
  const deps = dependencies();
  const plan = await handleDiscordInteraction({ interaction: command('plan'), actor, ...deps });
  assert.equal(plan.data.flags, 64);
  assert.deepEqual(plan.data.components[0].components.map((component) => component.label), ['Pick a game', 'Decide together', 'Use my voice channel']);

  const party = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: 'plan:pick-game' } }, actor, ...deps });
  assert.equal(party.type, 7);
  assert.equal(party.data.components[0].components[0].type, 3);
  assert.deepEqual(party.data.components[0].components[0].options.map((option) => option.label), ['Friend']);

  const flow = { id: '11111111-1111-1111-1111-111111111111', guild_id: actor.guildId, payload: {} };
  deps.flows.get = async () => flow;
  deps.planner.partyState = async () => ({ party: [{ discordUserId: actor.discordUserId, displayName: actor.displayName }, { discordUserId: '76561198000000001', displayName: 'Friend' }], unavailable: [], games: [{ appId: 548430, title: 'Deep Rock Galactic', minPlayers: 1, maxPlayers: 4 }] });
  const pickedPeople = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:members:${flow.id}`, values: ['76561198000000001'] } }, actor, ...deps,
  });
  assert.equal(pickedPeople.type, 7);
  assert.equal(pickedPeople.data.components[0].components[0].type, 3);
  assert.match(pickedPeople.data.content, /People in this session/);
  assert.match(pickedPeople.data.content, /Friend/);
  assert.equal(pickedPeople.data.components[2].components[0].custom_id, `party:change:${flow.id}`);

  flow.payload = { party: ['76561198000000001'] };
  const changedParty = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:change:${flow.id}` } }, actor, ...deps,
  });
  assert.equal(changedParty.type, 7);
  assert.equal(changedParty.data.components[0].components[0].options[0].default, true);

  const pickedGame = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:game:${flow.id}`, values: ['548430'] } }, actor, ...deps,
  });
  assert.equal(pickedGame.type, 7);
  assert.equal(pickedGame.data.components[0].components[0].custom_id, `party:date:${flow.id}`);
  flow.payload = { party: ['76561198000000001'], appId: 548430 };
  const pickedDate = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:date:${flow.id}`, values: ['2030-01-01'] } }, actor, ...deps });
  assert.equal(pickedDate.data.components[0].components[0].custom_id, `party:time:${flow.id}`);
  flow.payload = { party: ['76561198000000001'], appId: 548430, date: '2030-01-01' };
  const pickedTime = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:time:${flow.id}`, values: ['20:00'] } }, actor, ...deps });
  assert.equal(pickedTime.type, 9);
  assert.equal(pickedTime.data.custom_id, `party:create:${flow.id}`);
});

test('Pick a game only offers people with a complete Steam sync', async () => {
  const deps = dependencies();
  deps.planner.getPlanner = async () => [
    { discordUserId: actor.discordUserId, displayName: actor.displayName, steam: { syncStatus: 'complete' } },
    { discordUserId: '76561198000000001', displayName: 'Ready friend', steam: { syncStatus: 'complete' } },
    { discordUserId: '76561198000000002', displayName: 'Syncing friend', steam: { syncStatus: 'syncing' } },
    { discordUserId: '76561198000000003', displayName: 'Unlinked friend', steam: null },
  ];

  const response = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: 'plan:pick-game' } }, actor, ...deps });

  assert.deepEqual(response.data.components[0].components[0].options.map((option) => option.label), ['Ready friend']);
});

test('Decide together starts from plan and uses Discord date and time pickers', async () => {
  const deps = dependencies();
  deps.rallies = {};
  const response = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: 'plan:decide-together' } }, actor, ...deps });
  assert.equal(response.type, 7);
  assert.match(response.data.content, /Decide together/);
  assert.equal(response.data.components[0].components[0].custom_id.startsWith('rally:date:'), true);
});

test('party summary uses the Planner’s database-shaped member records', async () => {
  const deps = dependencies();
  const flow = { id: '11111111-1111-1111-1111-111111111111', guild_id: actor.guildId, payload: {} };
  deps.flows.get = async () => flow;
  deps.planner.partyState = async () => ({
    party: [
      { discord_user_id: actor.discordUserId, display_name: actor.displayName },
      { discord_user_id: '76561198000000001', display_name: 'Friend' },
    ],
    unavailable: [],
    games: [{ appId: 548430, title: 'Deep Rock Galactic', minPlayers: 1, maxPlayers: 4 }],
  });
  const response = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:members:${flow.id}`, values: ['76561198000000001'] } },
    actor,
    ...deps,
  });
  assert.match(response.data.content, /• Rally/);
  assert.match(response.data.content, /• Friend/);
  assert.doesNotMatch(response.data.content, /undefined/);
});

test('UK time picker starts at the next half-hour in Europe/London', () => {
  const options = londonTimeOptions(new Date('2026-08-23T13:45:00.000Z'));
  assert.equal(options[0].value, '15:00');
});

test('shared games are paged in Discord and uncurated games use a useful label', async () => {
  const deps = dependencies();
  const flow = { id: '11111111-1111-1111-1111-111111111111', guild_id: actor.guildId, payload: { party: ['76561198000000001'] } };
  deps.flows.get = async () => flow;
  const games = Array.from({ length: 26 }, (_, index) => ({ appId: index + 1, title: `Game ${String(index + 1).padStart(2, '0')}`, minPlayers: null, maxPlayers: null }));
  deps.planner.partyState = async () => ({ party: [{ discordUserId: actor.discordUserId, displayName: actor.displayName }, { discordUserId: '76561198000000001', displayName: 'Friend' }], unavailable: [], games });
  const response = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:games:${flow.id}:1` } }, actor, ...deps });
  assert.equal(response.type, 7);
  assert.equal(response.data.components[0].components[0].options[0].label, 'Game 26');
  assert.equal(response.data.components[0].components[0].options[0].description, 'Uncurated: confirm player count before inviting.');
  assert.equal(response.data.components[1].components[1].label, 'Page 2 of 2');
});

test('an unconfigured game asks its party host for reusable server player counts', async () => {
  const deps = dependencies();
  const flow = { id: '11111111-1111-1111-1111-111111111111', guild_id: actor.guildId, payload: { party: ['76561198000000001'] } };
  deps.flows.get = async () => flow;
  const game = { appId: 999999, title: 'Community Test Game', minPlayers: null, maxPlayers: null, ruleSource: 'unconfigured' };
  deps.planner.partyState = async () => ({ party: [{ discordUserId: actor.discordUserId, displayName: actor.displayName }, { discordUserId: '76561198000000001', displayName: 'Friend' }], unavailable: [], games: [game] });
  const selected = await handleDiscordInteraction({ interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:game:${flow.id}`, values: ['999999'] } }, actor, ...deps });
  assert.equal(selected.type, 9);
  assert.equal(selected.data.custom_id, `party:rules:${flow.id}`);
  assert.equal(selected.data.components[0].components[0].custom_id, 'min-players');
  assert.equal(selected.data.components[1].components[0].custom_id, 'max-players');

  flow.payload.appId = 999999;
  const ownership = await handleDiscordInteraction({
    interaction: { type: 5, guild_id: actor.guildId, data: { custom_id: `party:rules:${flow.id}`, components: [{ components: [{ custom_id: 'min-players', value: '2' }] }, { components: [{ custom_id: 'max-players', value: '6' }] }] } },
    actor,
    ...deps,
  });
  assert.equal(ownership.data.components[0].components[0].custom_id, `party:ownership:${flow.id}`);

  flow.payload.pendingRule = { minPlayers: 2, maxPlayers: 6 };
  let saved;
  deps.planner.saveGuildGameRule = async (input) => { saved = input; return { appId: 999999, minPlayers: 2, maxPlayers: 6, requiresAllOwners: false }; };
  const configured = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, data: { custom_id: `party:ownership:${flow.id}`, values: ['one'] } },
    actor,
    ...deps,
  });
  assert.deepEqual(saved, { guildId: actor.guildId, steamAppId: 999999, gameName: 'Community Test Game', minPlayers: 2, maxPlayers: 6, requiresAllOwners: false, configuredByDiscordUserId: actor.discordUserId });
  assert.equal(configured.type, 7);
  assert.match(configured.data.content, /now configured for this server/);
  assert.equal(configured.data.components[0].components[0].custom_id, `party:date:${flow.id}`);
});

test('party session modal creates, invites, and automatically publishes to the Session Feed', async () => {
  const deps = dependencies();
  const flow = { id: '11111111-1111-1111-1111-111111111111', guild_id: actor.guildId, payload: { party: ['76561198000000001'], appId: 548430, date: '2030-01-01', time: '20:00' } };
  deps.flows.get = async () => flow;
  let invited = false;
  deps.planner.createSession = async () => ({ id: '22222222-2222-2222-2222-222222222222', guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, game: { title: 'Deep Rock Galactic' }, startsAt: '2030-01-01T20:00:00.000Z', rsvps: [] });
  deps.sendInvites = async () => { invited = true; };
  let published;
  deps.publishSessionToFeed = async (session) => { published = session; return { published: true, channelId: 'channel-1' }; };
  const response = await handleDiscordInteraction({
    interaction: { type: 5, guild_id: actor.guildId, data: { custom_id: `party:create:${flow.id}`, components: [{ components: [{ custom_id: 'starts-at', value: '2030-01-01T20:00' }] }, { components: [{ custom_id: 'host-note', value: 'Bring snacks' }] }] } }, actor, ...deps,
  });
  assert.equal(response.data.flags, 64);
  assert.match(response.data.content, /is planned/);
  assert.match(response.data.content, /published in <#channel-1>/);
  assert.equal(invited, true);
  assert.equal(published.id, '22222222-2222-2222-2222-222222222222');
  assert.deepEqual(response.data.components, []);
});

test('a Session Feed permission failure keeps the planned session and explains the repair', async () => {
  const deps = dependencies();
  const flow = { id: '11111111-1111-1111-1111-111111111111', guild_id: actor.guildId, payload: { party: ['76561198000000001'], appId: 548430, date: '2030-01-01', time: '20:00' } };
  deps.flows.get = async () => flow;
  deps.planner.createSession = async () => ({ id: '22222222-2222-2222-2222-222222222222', guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, game: { title: 'Deep Rock Galactic' }, startsAt: '2030-01-01T20:00:00.000Z', rsvps: [] });
  deps.publishSessionToFeed = async () => ({ published: false, error: 'GamePlan cannot post in the configured Session Feed; ask an admin to check its permissions.' });
  const response = await handleDiscordInteraction({
    interaction: { type: 5, guild_id: actor.guildId, data: { custom_id: `party:create:${flow.id}`, components: [{ components: [{ custom_id: 'host-note', value: '' }] }] } }, actor, ...deps,
  });
  assert.match(response.data.content, /is planned/);
  assert.match(response.data.content, /could not be published to the Session Feed/);
  assert.doesNotMatch(response.data.content, /Could not create the session/);
});

test('LFG Leave edits the public card with the remaining roster', async () => {
  const deps = dependencies();
  const sessionId = '22222222-2222-2222-2222-222222222222';
  deps.database.query = async () => ({ rowCount: 1, rows: [{}] });
  deps.planner.leaveLfg = async (input) => {
    assert.deepEqual(input, { id: sessionId, guildId: actor.guildId, discordUserId: actor.discordUserId });
    return {
      id: sessionId,
      guildId: actor.guildId,
      hostDiscordUserId: 'discord-host',
      game: { title: 'Deep Rock Galactic', maxPlayers: 4 },
      startsAt: '2030-01-01T20:00:00.000Z',
      rsvps: [{ discordUserId: 'discord-host', displayName: 'Host', response: 'accepted' }],
    };
  };
  const response = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', message: { id: 'message-1' }, data: { custom_id: `lfg:${sessionId}:leave` } },
    actor,
    ...deps,
  });
  assert.equal(response.type, 7);
  assert.equal(response.data.content, undefined);
  assert.match(response.data.embeds[0].fields.find((field) => field.name === 'Roster').value, /1\/4 confirmed.*3 slots left/);
});

test('LFG cancellation asks for an optional reason, then archives the original card', async () => {
  const deps = dependencies();
  const sessionId = '44444444-4444-4444-4444-444444444444';
  const session = {
    id: sessionId,
    guildId: actor.guildId,
    hostDiscordUserId: actor.discordUserId,
    game: { title: 'Deep Rock Galactic', maxPlayers: 4 },
    startsAt: '2030-01-01T20:00:00.000Z',
    hostNote: 'Bring snacks',
    rsvps: [{ discordUserId: actor.discordUserId, displayName: actor.displayName, response: 'accepted' }],
  };
  deps.database.query = async () => ({ rowCount: 1, rows: [{ discussion_thread_id: null }] });
  deps.planner.getSession = async () => session;
  const cancel = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', message: { id: 'message-1' }, data: { custom_id: `lfg:${sessionId}:cancel` } },
    actor,
    ...deps,
  });
  assert.equal(cancel.type, 9);
  assert.equal(cancel.data.custom_id, `lfg:${sessionId}:cancel-submit`);
  assert.equal(cancel.data.components[0].components[0].custom_id, 'cancellation-reason');

  deps.planner.cancelSession = async (input) => {
    assert.deepEqual(input, { id: sessionId, guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, cancellationReason: 'Not enough players tonight' });
    return { cancelled: true, cancellationReason: 'Not enough players tonight' };
  };
  const submitted = await handleDiscordInteraction({
    interaction: { type: 5, guild_id: actor.guildId, data: { custom_id: `lfg:${sessionId}:cancel-submit`, components: [{ components: [{ custom_id: 'cancellation-reason', value: 'Not enough players tonight' }] }] } },
    actor,
    ...deps,
  });
  assert.equal(submitted.type, 7);
  assert.match(submitted.data.embeds[0].title, /Cancelled.*Deep Rock Galactic/);
  assert.match(submitted.data.embeds[0].description, /Not enough players tonight/);
  assert.deepEqual(submitted.data.components, []);
});

test('LFG Host transfer requires a confirmed participant and updates the original card', async () => {
  const deps = dependencies();
  const sessionId = '33333333-3333-3333-3333-333333333333';
  deps.database.query = async () => ({ rowCount: 1, rows: [{}] });
  const session = {
    id: sessionId,
    guildId: actor.guildId,
    hostDiscordUserId: actor.discordUserId,
    game: { title: 'Deep Rock Galactic', maxPlayers: 4 },
    startsAt: '2030-01-01T20:00:00.000Z',
    rsvps: [
      { discordUserId: actor.discordUserId, displayName: actor.displayName, response: 'accepted' },
      { discordUserId: 'discord-friend', displayName: 'Friend', response: 'accepted' },
    ],
  };
  deps.planner.getSession = async () => session;
  const transfer = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', message: { id: 'message-1' }, data: { custom_id: `lfg:${sessionId}:transfer` } },
    actor,
    ...deps,
  });
  assert.equal(transfer.type, 7);
  assert.equal(transfer.data.components[0].components[0].custom_id, `lfg:${sessionId}:transfer-to`);
  assert.deepEqual(transfer.data.components[0].components[0].options, [{ label: 'Friend', value: 'discord-friend' }]);

  deps.planner.transferHost = async (input) => {
    assert.deepEqual(input, {
      id: sessionId,
      guildId: actor.guildId,
      hostDiscordUserId: actor.discordUserId,
      newHostDiscordUserId: 'discord-friend',
    });
    return { ...session, hostDiscordUserId: 'discord-friend' };
  };
  const transferred = await handleDiscordInteraction({
    interaction: { type: 3, guild_id: actor.guildId, channel_id: 'channel-1', message: { id: 'message-1' }, data: { custom_id: `lfg:${sessionId}:transfer-to`, values: ['discord-friend'] } },
    actor,
    ...deps,
  });
  assert.equal(transferred.type, 7);
  assert.equal(transferred.data.content, undefined);
  assert.match(transferred.data.embeds[0].fields.find((field) => field.name === 'Roster').value, /Friend \(Host\)/);
});

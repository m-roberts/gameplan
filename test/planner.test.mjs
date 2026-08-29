import assert from 'node:assert/strict';
import test from 'node:test';
import { gameFitsParty, gamePolicy } from '../src/game-policy.mjs';
import { PlannerService } from '../src/planner.mjs';

test('curated player-count policy canonicalises known Steam app IDs', () => {
  const deepRock = gamePolicy(548430, 'A different store title');
  assert.equal(deepRock.canonicalTitle, 'Deep Rock Galactic');
  assert.equal(gameFitsParty(deepRock, 4), true);
  assert.equal(gameFitsParty(deepRock, 5), false);
});

test('unknown app IDs retain the Steam title without inventing player limits', () => {
  const unknown = gamePolicy(999999, 'Community Test Game');
  assert.equal(unknown.canonicalTitle, 'Community Test Game');
  assert.equal(unknown.minPlayers, null);
  assert.equal(gameFitsParty(unknown, 12), true);
});

test('group returns known members and an ownership matrix source', async () => {
  const database = {
    async query(sql) {
      if (sql.includes('FROM guild_members')) return { rowCount: 2, rows: [
        { discord_user_id: 'u1', display_name: 'Host', steam_id: 's1', last_sync_status: 'complete', last_sync_at: null },
        { discord_user_id: 'u2', display_name: 'Friend', steam_id: null, last_sync_status: null, last_sync_at: null },
      ] };
      if (sql.includes('FROM steam_owned_games games')) return { rowCount: 1, rows: [{ app_id: 42, title: 'Test Game', owner_ids: ['u1'] }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const group = await new PlannerService({ database }).getGroup('guild-1', 'u1');
  assert.equal(group.members.length, 2);
  assert.deepEqual(group.games, [{ appId: 42, title: 'Test Game', ownerIds: ['u1'] }]);
});

test('a Guild Game Rule overrides uncurated player counts for that server only', async () => {
  let candidateQuery;
  const database = {
    async query(sql, values) {
      if (sql.includes('FROM guild_members')) return { rowCount: 2, rows: [
        { discord_user_id: '76561198000000001', display_name: 'Host', steam_id: '1', last_sync_status: 'complete', last_sync_at: null },
        { discord_user_id: '76561198000000002', display_name: 'Friend', steam_id: '2', last_sync_status: 'complete', last_sync_at: null },
      ] };
      if (sql.includes('FROM steam_owned_games games')) {
        candidateQuery = { sql, values };
        return { rowCount: 1, rows: [{ app_id: 999999, store_title: 'Community Test Game', min_players: 2, max_players: 6, requires_all_owners: false, owner_count: 1 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const state = await new PlannerService({ database }).partyState('guild-1', '76561198000000001', ['76561198000000002']);
  assert.match(candidateQuery.sql, /rules\.guild_id = \$2/);
  assert.deepEqual(candidateQuery.values, [['76561198000000001', '76561198000000002'], 'guild-1']);
  assert.deepEqual(state.games[0], {
    appId: 999999,
    title: 'Community Test Game',
    storeTitle: 'Community Test Game',
    canonicalTitle: 'Community Test Game',
    minPlayers: 2,
    maxPlayers: 6,
    policyNote: 'Player count configured by this Discord server.',
    ruleSource: 'guild',
    fitsParty: true,
    requiresAllOwners: false,
    ownerCount: 1,
    playerCountFits: true,
    ownershipFits: true,
    launchUrl: 'steam://run/999999',
  });
});

test('shared games require every selected person when the server rule requires all owners', async () => {
  let candidateQuery;
  const database = {
    async query(sql, values) {
      if (sql.includes('FROM guild_members')) return { rowCount: 2, rows: [
        { discord_user_id: '76561198000000001', display_name: 'Host', steam_id: '1', last_sync_status: 'complete', last_sync_at: null },
        { discord_user_id: '76561198000000002', display_name: 'Friend', steam_id: '2', last_sync_status: 'complete', last_sync_at: null },
      ] };
      if (sql.includes('FROM steam_owned_games games')) {
        candidateQuery = { sql, values };
        if (sql.includes('HAVING')) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ app_id: 999999, store_title: 'Not Actually Shared', min_players: 2, max_players: 6, requires_all_owners: true, owner_count: 1 }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };

  const state = await new PlannerService({ database }).partyState('guild-1', '76561198000000001', ['76561198000000002']);

  assert.match(candidateQuery.sql, /HAVING[\s\S]*count\(DISTINCT games\.discord_user_id\)[\s\S]*cardinality\(\$1::text\[\]\)/i);
  assert.deepEqual(state.games, []);
});

test('Game settings catalogue includes discovered games and preserves configured games with no current owners', async () => {
  const database = {
    async query(sql, values) {
      assert.match(sql, /WITH discovered_games/);
      assert.deepEqual(values, ['guild-1']);
      return { rowCount: 3, rows: [
        { app_id: 548430, store_title: 'Deep Rock Galactic', owner_count: 3, min_players: null, max_players: null, requires_all_owners: null },
        { app_id: 999999, store_title: 'Solo Test Game', owner_count: 1, min_players: 1, max_players: 1, requires_all_owners: true },
        { app_id: 888888, store_title: 'Retired Game', owner_count: 0, min_players: 2, max_players: 4, requires_all_owners: false },
      ] };
    },
  };

  const catalogue = await new PlannerService({ database }).listGuildGameSettings('guild-1');

  assert.deepEqual(catalogue, [
    {
      appId: 548430, title: 'Deep Rock Galactic', storeTitle: 'Deep Rock Galactic', ownerCount: 3,
      minPlayers: 1, maxPlayers: 4, requiresAllOwners: true, ruleSource: 'catalog', status: 'catalog-default',
      policyNote: 'One shared squad supports up to four players.',
    },
    {
      appId: 999999, title: 'Solo Test Game', storeTitle: 'Solo Test Game', ownerCount: 1,
      minPlayers: 1, maxPlayers: 1, requiresAllOwners: true, ruleSource: 'guild', status: 'server-setting',
      policyNote: 'Player count configured by this Discord server.',
    },
    {
      appId: 888888, title: 'Retired Game', storeTitle: 'Retired Game', ownerCount: 0,
      minPlayers: 2, maxPlayers: 4, requiresAllOwners: false, ruleSource: 'guild', status: 'server-setting',
      policyNote: 'Player count configured by this Discord server.',
    },
  ]);
});

test('replanning separates people here from people joining next and never changes a game by itself', async () => {
  const service = new PlannerService({ database: { async query() { throw new Error('Replanning options must not write to the database.'); } } });
  service.getSession = async () => ({
    id: 'session-1', guildId: 'guild-1', hostDiscordUserId: 'host',
    rsvps: [
      { discordUserId: 'host', displayName: 'Host', liveStatus: 'here' },
      { discordUserId: 'here', displayName: 'Here', liveStatus: 'here' },
      { discordUserId: 'late', displayName: 'Late', liveStatus: 'joining_next_game' },
      { discordUserId: 'left', displayName: 'Left', liveStatus: 'leaving' },
    ],
  });
  const parties = [];
  service.partyState = async (_guildId, _hostId, ids) => {
    parties.push(ids);
    return { unavailable: [], games: [{ appId: 42, title: 'Shared game', minPlayers: 2, maxPlayers: 4, requiresAllOwners: true, fitsParty: true }] };
  };
  service.listGamesTonight = async () => [{ id: 'current', title: 'Old game', status: 'now_playing' }, { id: 'next', title: 'Later game', status: 'up_next' }];

  const options = await service.replanOptions({ sessionId: 'session-1', hostDiscordUserId: 'host' });
  assert.deepEqual(parties, [['here'], ['here', 'late']]);
  assert.deepEqual(options.audiences.map((audience) => audience.people.map((person) => person.displayName)), [['Host', 'Here'], ['Host', 'Here', 'Late']]);
  assert.deepEqual(options.replaceableGames.map((game) => game.id), ['current', 'next']);
});

test('replacing a Game Tonight item preserves the old item as history and adds the host-chosen alternative', async () => {
  const queries = [];
  const client = { async query(sql, values) {
    queries.push({ sql, values });
    if (sql.includes('SELECT g.id,g.game_name')) return { rowCount: 1, rows: [{ id: 'old-game', game_name: 'Old game', status: 'now_playing', position: 0 }] };
    return { rowCount: 0, rows: [] };
  }, release() {} };
  const service = new PlannerService({ database: { async connect() { return client; } } });
  service.replanOptions = async () => ({ audiences: [{ key: 'here_now', label: 'People here now', playerIds: ['host', 'friend'], alternatives: [{ appId: 42, title: 'Shared game' }] }] });
  service.listGamesTonight = async () => [{ id: 'new-game', title: 'Shared game', status: 'now_playing' }, { id: 'old-game', title: 'Old game', status: 'replaced' }];

  const result = await service.replaceGameTonight({ sessionId: 'session-1', gameId: 'old-game', hostDiscordUserId: 'host', audience: 'here_now', appId: 42 });
  assert.equal(result.replaced.title, 'Old game');
  assert.equal(result.replacement.title, 'Shared game');
  assert.ok(queries.some(({ sql }) => sql.includes("status='replaced'")));
  assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO game_night_games')));
  assert.equal(queries.filter(({ sql }) => sql.includes('INSERT INTO game_night_game_players')).length, 2);
});

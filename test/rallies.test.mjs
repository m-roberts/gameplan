import assert from 'node:assert/strict';
import test from 'node:test';
import { rallyCard } from '../src/discord-bot.mjs';
import { RallyService } from '../src/rallies.mjs';

test('a game-vote card makes its undecided state, Steam readiness, and roster freeze explicit', () => {
  const card = rallyCard({
    id: '11111111-1111-1111-1111-111111111111', state: 'open', startsAt: '2026-08-23T19:00:00.000Z',
    hostDiscordUserId: 'host', rosterSource: 'voice', voiceChannelId: 'voice-1', members: [
      { discordUserId: 'host', displayName: 'Host', status: 'in', steamReady: true },
      { discordUserId: 'friend', displayName: 'Friend', status: 'in', steamReady: false },
    ], candidates: [],
  });
  assert.match(card.embeds[0].title, /Game undecided/);
  assert.match(card.embeds[0].fields.find((field) => field.name === 'Roster').value, /2 attending · 1 Steam-ready/);
  assert.equal(card.components[0].components.some((component) => component.custom_id.endsWith(':open-poll')), true);
});

test('Rally ranking prioritises viable participation before ranked preference points', async () => {
  const service = new RallyService({ database: {} });
  service.get = async () => ({ state: 'polling', candidates: [
    { appId: 1, title: 'Four-player game', potentialParticipants: 4 },
    { appId: 2, title: 'Two-player favourite', potentialParticipants: 2 },
  ], votes: [
    { discordUserId: 'a', rankings: [{ appId: 2, rank: 1 }, { appId: 1, rank: 2 }] },
    { discordUserId: 'b', rankings: [{ appId: 2, rank: 1 }, { appId: 1, rank: 2 }] },
  ] });
  const result = await service.result('rally-1');
  assert.equal(result.ranked[0].appId, 1);
  assert.equal(result.ranked[0].preferencePoints, 4);
  assert.equal(result.ranked[1].preferencePoints, 6);
});

test('Rally ranking reports an exact tie for the host to resolve explicitly', async () => {
  const service = new RallyService({ database: {} });
  service.get = async () => ({ state: 'polling', candidates: [
    { appId: 1, title: 'A', potentialParticipants: 4 },
    { appId: 2, title: 'B', potentialParticipants: 4 },
  ], votes: [] });
  const result = await service.result('rally-1');
  assert.equal(result.recommendedAppId, null);
  assert.deepEqual(result.tiedAppIds, [1, 2]);
});

test('Rally candidate lookup binds the guild rule scope as its second parameter', async () => {
  const queries = [];
  const database = {
    query: async (sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('FROM guild_members')) return { rows: [{ discord_user_id: 'player-1', last_sync_status: 'complete' }] };
      if (sql.includes('FROM steam_owned_games')) return { rows: [] };
      if (sql.includes('FROM voice_channel_members')) return { rows: [{ observed_at: null }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const service = new RallyService({ database });

  await service.buildCandidates({ guildId: 'guild-1', participantIds: ['player-1'] });

  const candidateQuery = queries.find(({ sql }) => sql.includes('FROM steam_owned_games'));
  assert.match(candidateQuery.sql, /rules\.guild_id=\$2/);
  assert.deepEqual(candidateQuery.values, [['player-1'], 'guild-1']);
});

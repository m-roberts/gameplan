import assert from 'node:assert/strict';
import test from 'node:test';
import { DiscordMemberSync } from '../src/member-sync.mjs';

function member(id, name = `User ${id}`) {
  return { nick: null, user: { id, global_name: name, username: name } };
}

test('syncGuild imports every Discord member across paginated responses', async () => {
  const pages = [Array.from({ length: 1000 }, (_, index) => member(String(index + 1))), [member('1001', 'Last user')]];
  const requests = [];
  const queries = [];
  const sync = new DiscordMemberSync({
    database: { async query(sql, values) { queries.push({ sql, values }); } },
    bot: { async guildMembers(guildId, options) { requests.push({ guildId, options }); return pages.shift(); } },
  });

  assert.equal(await sync.syncGuild('guild-1'), 1001);
  assert.deepEqual(requests, [
    { guildId: 'guild-1', options: { limit: 1000, after: null } },
    { guildId: 'guild-1', options: { limit: 1000, after: '1000' } },
  ]);
  assert.equal(queries.length, 3);
  assert.match(queries[0].sql, /INSERT INTO discord_users/);
  assert.deepEqual(queries[0].values[0].slice(0, 3), ['1', '2', '3']);
  assert.equal(queries[0].values[0].length, 1000);
  assert.equal(queries[1].values[0][0], '1001');
  assert.match(queries[2].sql, /DELETE FROM guild_members/);
  assert.equal(queries[2].values[1].length, 1001);
});

test('syncAll continues syncing other installed guilds after one fails', async () => {
  const warnings = [];
  const synced = [];
  const sync = new DiscordMemberSync({
    database: { async query() { return { rows: [{ guild_id: 'bad' }, { guild_id: 'good' }] }; } },
    bot: { async guildMembers(guildId) { synced.push(guildId); if (guildId === 'bad') throw new Error('forbidden'); return []; } },
    logger: { warn(message) { warnings.push(message); } },
  });

  assert.deepEqual(await sync.syncAll(), { guilds: 2, failures: 1 });
  assert.deepEqual(synced.sort(), ['bad', 'good']);
  assert.match(warnings[0], /forbidden/);
});

test('start runs an immediate sync and schedules later syncs, stop cancels the timer', async () => {
  const callbacks = [];
  const cleared = [];
  let runs = 0;
  const sync = new DiscordMemberSync({
    database: { async query(sql) { if (sql.startsWith('SELECT')) runs += 1; return { rows: [] }; } },
    bot: {},
    intervalMs: 1234,
    setIntervalImpl(callback, intervalMs) { callbacks.push({ callback, intervalMs }); return 'timer'; },
    clearIntervalImpl(timer) { cleared.push(timer); },
  });

  sync.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.deepEqual(callbacks, [{ callback: callbacks[0].callback, intervalMs: 1234 }]);
  callbacks[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 2);
  sync.stop();
  assert.deepEqual(cleared, ['timer']);
});

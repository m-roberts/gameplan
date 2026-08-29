import assert from 'node:assert/strict';
import test from 'node:test';
import { GuildPolicyService, isGuildAdmin } from '../src/guild-policy.mjs';

test('Discord Manage Guild and Administrator permission bits grant GamePlan setup authority', () => {
  assert.equal(isGuildAdmin('0'), false);
  assert.equal(isGuildAdmin(String(1n << 5n)), true);
  assert.equal(isGuildAdmin(String(1n << 3n)), true);
});

test('Guild Policy denies cross-guild channels and non-Coordinator publishing', async () => {
  const database = {
    query: async (sql, values) => {
      if (sql.startsWith('SELECT 1 FROM guild_policy_channels')) return { rowCount: values[0] === 'guild-a' && values[1] === 'channel-a' ? 1 : 0, rows: [] };
      if (sql.startsWith('SELECT default_lfg_channel_id')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('SELECT channel_id')) return { rowCount: 0, rows: [] };
      if (sql.startsWith('SELECT role_id')) return { rowCount: 1, rows: [{ role_id: 'coordinator-a' }] };
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const policy = new GuildPolicyService({ database });
  assert.equal(await policy.allowsChannel('guild-a', 'channel-a'), true);
  assert.equal(await policy.allowsChannel('guild-b', 'channel-a'), false);
  assert.equal(await policy.canPublish({ guildId: 'guild-a', permissions: '0', roleIds: ['member'] }), false);
  assert.equal(await policy.canPublish({ guildId: 'guild-a', permissions: '0', roleIds: ['coordinator-a'] }), true);
  assert.equal(await policy.canPublish({ guildId: 'guild-a', permissions: String(1n << 5n), roleIds: [] }), true);
});

test('a server is not ready until it has a Session Feed', async () => {
  const queries = [];
  const policy = new GuildPolicyService({ database: { async query(sql, values) { queries.push({ sql, values }); return { rowCount: values[0] === 'configured-guild' ? 1 : 0, rows: [] }; } } });
  assert.equal(await policy.isInstalled('configured-guild'), true);
  assert.equal(await policy.isInstalled('unconfigured-guild'), false);
  assert.match(queries[0].sql, /guild_policies/);
  assert.match(queries[0].sql, /default_lfg_channel_id IS NOT NULL/);
});

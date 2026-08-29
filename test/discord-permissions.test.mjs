import assert from 'node:assert/strict';
import test from 'node:test';
import { canPostInChannel, guildPermissionsForMember } from '../src/discord-bot.mjs';

const guildId = 'guild-1';
const member = { user: { id: 'bot-1' }, roles: ['bot-role'] };
const roles = [
  { id: guildId, permissions: '0' },
  { id: 'bot-role', permissions: String((1n << 10n) | (1n << 11n)) },
];

test('only channels the bot can view and send to are eligible for Guild Policy', () => {
  const openChannel = { id: 'open', type: 0, permission_overwrites: [] };
  const blockedChannel = {
    id: 'blocked', type: 0,
    permission_overwrites: [{ id: 'bot-role', type: 0, allow: '0', deny: String(1n << 11n) }],
  };
  assert.equal(canPostInChannel({ channel: openChannel, guildId, roles, member }), true);
  assert.equal(canPostInChannel({ channel: blockedChannel, guildId, roles, member }), false);
  assert.equal(canPostInChannel({ channel: { id: 'voice', type: 2 }, guildId, roles, member }), false);
});

test('server authority is derived from the member’s current roles', () => {
  assert.equal(guildPermissionsForMember({ guildId, roles, member }), (1n << 10n) | (1n << 11n));
  assert.equal(guildPermissionsForMember({ guildId, roles, member: { roles: [] } }), 0n);
});

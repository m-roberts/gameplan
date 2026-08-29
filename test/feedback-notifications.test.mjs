import assert from 'node:assert/strict';
import test from 'node:test';
import { discordUserFromFiderIdentity } from '../src/feedback-notifications.mjs';

test('feedback notifications only accept GamePlan synthetic Fider identities', () => {
  assert.equal(discordUserFromFiderIdentity('discord-123456789012345678@users.gameplan.invalid'), '123456789012345678');
  assert.equal(discordUserFromFiderIdentity('person@example.com'), null);
  assert.equal(discordUserFromFiderIdentity('discord-123@users.gameplan.invalid'), null);
  assert.equal(discordUserFromFiderIdentity(null), null);
});

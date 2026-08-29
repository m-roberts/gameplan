import assert from 'node:assert/strict';
import test from 'node:test';
import { isQuietNow, NotificationService } from '../src/notifications.mjs';

test('quiet hours respect a user timezone and span midnight', () => {
  assert.equal(isQuietNow({ timezone: 'UTC', quietStart: '21:00', quietEnd: '07:00' }, new Date('2030-01-01T22:00:00Z')), true);
  assert.equal(isQuietNow({ timezone: 'UTC', quietStart: '21:00', quietEnd: '07:00' }, new Date('2030-01-01T12:00:00Z')), false);
  assert.equal(isQuietNow({ timezone: 'UTC', quietStart: null, quietEnd: null }, new Date('2030-01-01T22:00:00Z')), false);
});

test('delivery creation uses an immutable dedupe key', async () => {
  const calls = [];
  const service = new NotificationService({ database: { async query(sql, values) { calls.push({ sql, values }); return { rowCount: 0, rows: [] }; } } });
  await service.createDelivery({ kind: 'session_reminder', dedupeKey: 'reminder:session:user:60:start', guildId: 'guild', discordUserId: 'user', sessionId: '11111111-1111-1111-1111-111111111111', delivery: 'dm', expectedStartsAt: '2030-01-01T20:00:00.000Z', scheduledAt: '2030-01-01T19:00:00.000Z', leadMinutes: 60 });
  assert.match(calls[0].sql, /ON CONFLICT \(dedupe_key\) DO NOTHING/);
  assert.equal(calls[0].values[1], 'reminder:session:user:60:start');
});

test('Games Tonight change deliveries default eligible people to a durable DM notification', async () => {
  const calls = [];
  const service = new NotificationService({ database: { async query(sql, values) { calls.push({ sql, values }); return { rowCount: 0, rows: calls.length === 1 ? [{ discord_user_id: 'host', delivery: 'dm' }, { discord_user_id: 'late-player', delivery: 'dm' }] : [] }; } } });
  await service.queueGameNightChange({ session: { id: '11111111-1111-1111-1111-111111111111', guildId: 'guild', startsAt: '2030-01-01T20:00:00.000Z' }, content: 'Games Tonight changed: **Spacewar** is now playing.', changeKey: 'status:game:now_playing' });
  assert.match(calls[0].sql, /session_live_statuses/);
  assert.equal(calls.slice(1).length, 2);
  assert.equal(calls[1].values[1], 'game-night-change:11111111-1111-1111-1111-111111111111:status:game:now_playing:host');
  assert.equal(calls[1].values[10], 'Games Tonight changed: **Spacewar** is now playing.');
});

test('failed deliveries are retained for retry before becoming visible failures', async () => {
  const calls = [];
  const service = new NotificationService({ database: { async query(sql, values) { calls.push({ sql, values }); return { rowCount: 0, rows: [] }; } } });
  await service.retry('delivery-id', 'Discord was unavailable');
  assert.match(calls[0].sql, /interval '5 minutes'/);
  assert.equal(calls[0].values[1], 'Discord was unavailable');
});

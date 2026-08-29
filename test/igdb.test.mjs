import test from 'node:test';
import assert from 'node:assert/strict';
import { derivePlayerSupport, IgdbClient, mapIgdbGame } from '../src/igdb.mjs';

test('maps IGDB multiplayer metadata to conservative player defaults', () => {
  assert.deepEqual(mapIgdbGame({ id: 42, name: 'Example', multiplayer_modes: [{ onlinecoop: true, onlinecoopmax: 4 }] }), {
    providerGameId: 42,
    providerName: 'Example',
    minPlayers: 2,
    maxPlayers: 4,
    online: false,
    onlineCoop: true,
    localMultiplayer: false,
    localCoop: false,
    splitScreen: false,
  });
  assert.equal(derivePlayerSupport([]), null);
  assert.equal(mapIgdbGame({ id: 42 }), null);
});

test('resolves Steam AppID through IGDB and does not make a second token request', async () => {
  const calls = [];
  const responses = [
    { ok: true, json: async () => ({ access_token: 'token', expires_in: 3600 }) },
    { ok: true, json: async () => ([{ game: 42 }]) },
    { ok: true, json: async () => ([{ id: 42, name: 'Example', multiplayer_modes: [{ online: true, onlinemax: 8 }] }]) },
  ];
  const client = new IgdbClient({ clientId: 'id', clientSecret: 'secret', fetchImpl: async (...args) => { calls.push(args); return responses.shift(); } });
  assert.deepEqual(await client.findSteamGame(12345), {
    providerGameId: 42,
    providerName: 'Example',
    minPlayers: 2,
    maxPlayers: 8,
    online: true,
    onlineCoop: false,
    localMultiplayer: false,
    localCoop: false,
    splitScreen: false,
  });
  assert.equal(calls.length, 3);
  assert.match(calls[1][1].body, /uid = "12345"/);
  assert.match(calls[1][1].body, /category = 1/);
});

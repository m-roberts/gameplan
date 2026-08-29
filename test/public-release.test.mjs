import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('public release materials use the current Discord command surface', async () => {
  const materials = await Promise.all([
    read('README.md'),
    read('docs/quickstart.md'),
    read('docs/discord-setup.md'),
    read('docs/operations.md'),
    read('src/discord.mjs'),
    read('src/interaction-router.mjs'),
    read('src/server.mjs'),
  ]);
  assert.equal(materials.some((material) => material.includes('/game-plan')), false);
  assert.equal(materials.some((material) => material.includes('/gameplan manage')), false);
});

test('example configuration never carries a deployment Discord application ID', async () => {
  const env = await read('.env.example');
  assert.match(env, /^DISCORD_APPLICATION_ID=$/m);
  assert.match(env, /^DISCORD_PUBLIC_KEY=$/m);
  assert.match(env, /^DISCORD_BOT_TOKEN=$/m);
});

test('README artwork is included in the repository', async () => {
  const artwork = await stat(new URL('docs/assets/gameplan-hero.png', root));
  assert.ok(artwork.size > 0);
});

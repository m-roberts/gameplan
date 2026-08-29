import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Pages site is generic, self-contained, and links to its public docs', async () => {
  const html = await readFile(new URL('../site/index.html', import.meta.url), 'utf8');

  for (const expected of [
    'Make game night happen',
    'Game Night',
    'Regular Game Night',
    'Game Vote',
    'Session Feed',
    'Games Tonight',
    '/gameplan start',
    '/gameplan server',
    'docs/quickstart/',
    'docs/discord-setup/',
    'docs/operations/',
    'docs/security-and-data/',
    'https://github.com/m-roberts/gameplan',
  ]) assert.match(html, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  for (const forbidden of ['cookwithai.app', 'feedback.gameplan', '/game-plan']) {
    assert.doesNotMatch(html.toLowerCase(), new RegExp(forbidden));
  }
});

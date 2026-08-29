import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const server = await readFile(new URL('../src/server.mjs', import.meta.url), 'utf8');

test('OAuth token endpoint supports Fider query-string exchanges and standard form posts', () => {
  assert.match(
    server,
    /\(request\.method === 'POST' \|\| request\.method === 'GET'\) && url\.pathname === '\/oauth\/token'/,
  );
  assert.match(
    server,
    /request\.method === 'GET' \? url\.searchParams : await readForm\(request\)/,
  );
});

test('a private browser link may continue only to the deployment-configured feedback URL', () => {
  assert.match(server, /const continueTo = url\.searchParams\.get\('continue'\);/);
  assert.match(server, /continueTo === config\.feedbackUrl \? continueTo : '\/'/);
});

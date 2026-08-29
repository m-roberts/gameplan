import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import test from 'node:test';

const migrations = new URL('../migrations/', import.meta.url);
const baseline = await readFile(new URL('0000_baseline.sql', migrations), 'utf8');

test('the fresh-install baseline contains every historical schema migration in order', async () => {
  const historical = (await readdir(migrations))
    .filter((name) => /^00(?:0[1-9]|1[0-9]|20)_.*\.sql$/.test(name))
    .sort();

  assert.equal(historical.length, 20);
  for (const name of historical) {
    const source = await readFile(new URL(name, migrations), 'utf8');
    assert.match(baseline, new RegExp(`-- Source: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(baseline.includes(source), `${name} is missing from 0000_baseline.sql`);
  }
});

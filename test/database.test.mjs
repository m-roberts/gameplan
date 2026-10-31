import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { createDatabase } from '../src/database.mjs';

test('an idle pool disconnect does not crash the caller or prevent the next query', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args));
  let calls = 0;
  t.mock.method(pg.Pool.prototype, 'query', async function () {
    if (calls++ === 0) {
      // pg-pool emits this on the pool after removing the dead idle client.
      this.emit('error', Object.assign(new Error('private connection detail'), { code: '57P01' }));
    }
    return { rows: [{ value: 1 }] };
  });
  const database = createDatabase('postgresql://unused/unused');
  try {
    await database.ping();
    assert.deepEqual((await database.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
    assert.equal(calls, 2);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0].join(' '), /57P01/);
    assert.doesNotMatch(warnings[0].join(' '), /private connection detail/);
  } finally {
    await database.close();
  }
});

test('query errors still reject for the caller to handle', async (t) => {
  const failure = Object.assign(new Error('query failed'), { code: 'ECONNREFUSED' });
  t.mock.method(pg.Pool.prototype, 'query', async () => { throw failure; });
  const database = createDatabase('postgresql://unused/unused');
  try {
    await assert.rejects(database.ping(), (error) => error === failure);
  } finally {
    await database.close();
  }
});

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import pg from 'pg';

const adminUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATION_TEST_DATABASE_URL must be configured');

const root = new URL('..', import.meta.url);
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
const freshDatabase = `gameplan_fresh_${suffix}`;
const upgradeDatabase = `gameplan_upgrade_${suffix}`;
const admin = new pg.Client({ connectionString: adminUrl });

function databaseUrl(name) {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function runMigration(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/migrate.mjs'], {
      cwd: root.pathname,
      env: { ...process.env, DATABASE_URL: databaseUrl(name) },
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`migration runner exited with ${code}`)));
  });
}

async function withDatabase(name, operation) {
  await admin.query(`CREATE DATABASE ${name}`);
  try {
    await operation(databaseUrl(name));
  } finally {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid <> pg_backend_pid()', [name]);
    await admin.query(`DROP DATABASE ${name}`);
  }
}

try {
  await admin.connect();

  await withDatabase(freshDatabase, async (url) => {
    await runMigration(freshDatabase);
    await runMigration(freshDatabase);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const result = await client.query('SELECT count(*)::int AS count FROM schema_migrations');
    assert.equal(result.rows[0].count, 21, 'fresh database records the baseline and every historical migration');
    await client.end();
  });

  await withDatabase(upgradeDatabase, async (url) => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query(await readFile(new URL('../migrations/0001_foundation.sql', import.meta.url), 'utf8'));
    await client.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await client.query("INSERT INTO schema_migrations(name) VALUES ('0001_foundation.sql')");
    await client.end();
    await runMigration(upgradeDatabase);
    const verified = new pg.Client({ connectionString: url });
    await verified.connect();
    const result = await verified.query('SELECT count(*)::int AS count FROM schema_migrations');
    assert.equal(result.rows[0].count, 20, 'existing database upgrades through numbered migrations without the baseline');
    await verified.end();
  });
} finally {
  await admin.end();
}

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL must be configured');

const directory = new URL('../migrations/', import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
const baseline = '0000_baseline.sql';
const incrementalMigrations = files.filter((name) => name !== baseline);
if (!files.includes(baseline)) throw new Error(`Missing ${baseline}`);
const pool = new pg.Pool({ connectionString });

try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const appliedMigrations = await pool.query('SELECT name FROM schema_migrations');
  if (appliedMigrations.rowCount === 0) {
    const sql = await readFile(join(directory.pathname, baseline), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [baseline]);
      for (const name of incrementalMigrations) {
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      }
      await client.query('COMMIT');
      console.log(`Applied ${baseline} for a fresh database`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  for (const name of incrementalMigrations) {
    const applied = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (applied.rowCount) continue;
    const sql = await readFile(join(directory.pathname, name), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      await client.query('COMMIT');
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await pool.end();
}

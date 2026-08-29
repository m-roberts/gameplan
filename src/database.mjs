import pg from 'pg';

export function createDatabase(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: (text, values) => pool.query(text, values),
    connect: () => pool.connect(),
    close: () => pool.end(),
    ping: async () => { await pool.query('SELECT 1'); },
  };
}

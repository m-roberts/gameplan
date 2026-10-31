import pg from 'pg';

export function createDatabase(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 10 });
  // pg removes broken idle clients before emitting this event. Keep the process
  // alive so subsequent queries can establish a fresh connection after recovery.
  pool.on('error', (error) => {
    console.warn('PostgreSQL idle connection lost; pool will reconnect.', error.code ?? 'unknown');
  });
  return {
    query: (text, values) => pool.query(text, values),
    connect: () => pool.connect(),
    close: () => pool.end(),
    ping: async () => { await pool.query('SELECT 1'); },
  };
}

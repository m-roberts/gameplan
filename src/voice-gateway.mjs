import { loadConfig } from './config.mjs';
import { createDatabase } from './database.mjs';

const GUILD_MEMBERS = 1 << 1;
const GUILD_VOICE_STATES = 1 << 7;
const RETRY_MS = 5_000;

function displayName(user = {}) { return user.global_name ?? user.username ?? null; }

async function recordVoiceState(database, state) {
  if (!state.guild_id || !state.user_id) return;
  const user = state.member?.user;
  await database.query(
    `INSERT INTO discord_users (discord_user_id,display_name) VALUES ($1,$2)
     ON CONFLICT (discord_user_id) DO UPDATE SET display_name=coalesce(EXCLUDED.display_name,discord_users.display_name),updated_at=now()`,
    [state.user_id, displayName(user)],
  );
  await database.query(
    `INSERT INTO guild_members (guild_id,discord_user_id)
     SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM guild_installations WHERE guild_id=$1)
     ON CONFLICT (guild_id,discord_user_id) DO UPDATE SET last_seen_at=now()`,
    [state.guild_id, state.user_id],
  );
  if (!state.channel_id) {
    await database.query('DELETE FROM voice_channel_members WHERE guild_id=$1 AND discord_user_id=$2', [state.guild_id, state.user_id]);
    return;
  }
  await database.query(
    `INSERT INTO voice_channel_members (guild_id,channel_id,discord_user_id,observed_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT (guild_id,discord_user_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,observed_at=now()`,
    [state.guild_id, state.channel_id, state.user_id],
  );
}

async function replaceGuildVoiceStates(database, guildId, states) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM voice_channel_members WHERE guild_id=$1', [guildId]);
    for (const state of states) {
      if (!state.channel_id || !state.user_id) continue;
      const user = state.member?.user;
      await client.query(
        `INSERT INTO discord_users (discord_user_id,display_name) VALUES ($1,$2)
         ON CONFLICT (discord_user_id) DO UPDATE SET display_name=coalesce(EXCLUDED.display_name,discord_users.display_name),updated_at=now()`,
        [state.user_id, displayName(user)],
      );
      await client.query(`INSERT INTO guild_members (guild_id,discord_user_id)
        SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM guild_installations WHERE guild_id=$1)
        ON CONFLICT (guild_id,discord_user_id) DO UPDATE SET last_seen_at=now()`, [guildId, state.user_id]);
      await client.query(`INSERT INTO voice_channel_members (guild_id,channel_id,discord_user_id,observed_at)
        VALUES ($1,$2,$3,now())`, [guildId, state.channel_id, state.user_id]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function setStatus(database, values = {}) {
  await database.query(
    `INSERT INTO voice_gateway_status (singleton,connected_at,last_event_at,updated_at)
     VALUES (true,$1,$2,now())
     ON CONFLICT (singleton) DO UPDATE SET connected_at=coalesce(EXCLUDED.connected_at,voice_gateway_status.connected_at),last_event_at=coalesce(EXCLUDED.last_event_at,voice_gateway_status.last_event_at),updated_at=now()`,
    [values.connectedAt ?? null, values.lastEventAt ?? null],
  );
}

async function gatewayUrl(token) {
  const response = await fetch('https://discord.com/api/v10/gateway/bot', { headers: { authorization: `Bot ${token}` } });
  if (!response.ok) throw new Error(`Discord gateway discovery returned HTTP ${response.status}`);
  const body = await response.json();
  return `${body.url}?v=10&encoding=json`;
}

export async function runVoiceGateway({ database, token, connect = WebSocket, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) }) {
  if (!token) throw new Error('DISCORD_BOT_TOKEN is required for the voice gateway.');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
  while (!stopping) {
    try {
      const url = await gatewayUrl(token);
      await new Promise((resolve, reject) => {
        const socket = new connect(url);
        let heartbeat = null;
        let settled = false;
        const close = () => {
          if (heartbeat) clearInterval(heartbeat);
          if (!settled) { settled = true; resolve(); }
        };
        socket.addEventListener('open', () => {});
        socket.addEventListener('error', (error) => { if (!settled) { settled = true; reject(error.error ?? error); } });
        socket.addEventListener('close', close);
        socket.addEventListener('message', async (event) => {
          try {
            const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
            if (message.op === 10) {
              heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: null })), message.d.heartbeat_interval);
              socket.send(JSON.stringify({ op: 2, d: { token, intents: GUILD_MEMBERS | GUILD_VOICE_STATES, properties: { os: process.platform, browser: 'gameplan', device: 'gameplan' } } }));
              return;
            }
            if (message.op === 7) { socket.close(); return; }
            if (message.op !== 0) return;
            await setStatus(database, { lastEventAt: new Date() });
            if (message.t === 'READY') await setStatus(database, { connectedAt: new Date(), lastEventAt: new Date() });
            if (message.t === 'GUILD_CREATE') await replaceGuildVoiceStates(database, message.d.id, message.d.voice_states ?? []);
            if (message.t === 'VOICE_STATE_UPDATE') await recordVoiceState(database, message.d);
          } catch (error) { console.error('Voice gateway event failed', error); }
        });
      });
    } catch (error) { console.error('Voice gateway connection failed', error); }
    if (!stopping) await sleep(RETRY_MS);
  }
}

if (import.meta.main) {
  const config = loadConfig();
  const database = createDatabase(config.databaseUrl);
  runVoiceGateway({ database, token: config.discordBotToken }).finally(() => database.close());
}

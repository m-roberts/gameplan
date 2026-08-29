import { newId } from './tokens.mjs';

const FLOW_TTL_MS = 30 * 60 * 1000;

export class DiscordFlowService {
  constructor({ database, now = () => new Date() }) { this.database = database; this.now = now; }

  async create({ kind, guildId, discordUserId, payload = {} }) {
    const id = newId();
    const expiresAt = new Date(this.now().getTime() + FLOW_TTL_MS);
    await this.database.query(
      `INSERT INTO discord_flow_states (id, kind, guild_id, discord_user_id, payload, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, kind, guildId, discordUserId, JSON.stringify(payload), expiresAt],
    );
    return { id, kind, guildId, discordUserId, payload, expiresAt };
  }

  async get({ id, kind, discordUserId }) {
    const result = await this.database.query(
      `SELECT id, kind, guild_id, discord_user_id, payload, expires_at
       FROM discord_flow_states
       WHERE id=$1 AND kind=$2 AND discord_user_id=$3 AND expires_at > now()`,
      [id, kind, discordUserId],
    );
    return result.rows[0] ?? null;
  }

  async update({ id, kind, discordUserId, payload }) {
    const result = await this.database.query(
      `UPDATE discord_flow_states SET payload=$4, updated_at=now()
       WHERE id=$1 AND kind=$2 AND discord_user_id=$3 AND expires_at > now()
       RETURNING id, kind, guild_id, discord_user_id, payload, expires_at`,
      [id, kind, discordUserId, JSON.stringify(payload)],
    );
    return result.rows[0] ?? null;
  }
}

export const discordFlowTtls = { FLOW_TTL_MS };

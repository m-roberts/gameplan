const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export function isGuildAdmin(permissions) {
  const value = BigInt(permissions ?? '0');
  return Boolean(value & (ADMINISTRATOR | MANAGE_GUILD));
}

export class GuildPolicyService {
  constructor({ database }) { this.database = database; }

  async get(guildId) {
    const policy = await this.database.query('SELECT default_lfg_channel_id FROM guild_policies WHERE guild_id=$1', [guildId]);
    const channels = await this.database.query('SELECT channel_id FROM guild_policy_channels WHERE guild_id=$1 ORDER BY channel_id', [guildId]);
    const roles = await this.database.query('SELECT role_id FROM guild_policy_coordinator_roles WHERE guild_id=$1 ORDER BY role_id', [guildId]);
    return { defaultLfgChannelId: policy.rows[0]?.default_lfg_channel_id ?? null, allowedChannelIds: channels.rows.map((row) => row.channel_id), coordinatorRoleIds: roles.rows.map((row) => row.role_id) };
  }

  async isInstalled(guildId) {
    // A server is ready only once it has somewhere reliable to publish every
    // planned session. Keep the legacy installation row for audit/history, but
    // do not treat it as a complete setup on its own.
    const result = await this.database.query('SELECT 1 FROM guild_policies WHERE guild_id=$1 AND default_lfg_channel_id IS NOT NULL', [guildId]);
    return Boolean(result.rowCount);
  }

  async allowsChannel(guildId, channelId) {
    if (!guildId || !channelId) return false;
    const result = await this.database.query('SELECT 1 FROM guild_policy_channels WHERE guild_id=$1 AND channel_id=$2', [guildId, channelId]);
    return Boolean(result.rowCount);
  }

  async addAllowedChannel({ guildId, channelId, actorId, makeDefault = false }) {
    await this.database.query('INSERT INTO guild_policies (guild_id, default_lfg_channel_id, updated_by_discord_user_id) VALUES ($1,$2,$3) ON CONFLICT (guild_id) DO UPDATE SET default_lfg_channel_id=CASE WHEN $4 THEN EXCLUDED.default_lfg_channel_id ELSE guild_policies.default_lfg_channel_id END, updated_by_discord_user_id=EXCLUDED.updated_by_discord_user_id,updated_at=now()', [guildId, makeDefault ? channelId : null, actorId, makeDefault]);
    await this.database.query('INSERT INTO guild_policy_channels (guild_id,channel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [guildId, channelId]);
    return this.get(guildId);
  }

  async removeAllowedChannel({ guildId, channelId, actorId }) {
    await this.database.query('DELETE FROM guild_policy_channels WHERE guild_id=$1 AND channel_id=$2', [guildId, channelId]);
    await this.database.query('UPDATE guild_policies SET default_lfg_channel_id=NULL, updated_by_discord_user_id=$3, updated_at=now() WHERE guild_id=$1 AND default_lfg_channel_id=$2', [guildId, channelId, actorId]);
    return this.get(guildId);
  }

  async addCoordinatorRole({ guildId, roleId, actorId }) {
    await this.database.query('INSERT INTO guild_policies (guild_id,updated_by_discord_user_id) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET updated_by_discord_user_id=EXCLUDED.updated_by_discord_user_id,updated_at=now()', [guildId, actorId]);
    await this.database.query('INSERT INTO guild_policy_coordinator_roles (guild_id,role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [guildId, roleId]);
    return this.get(guildId);
  }

  async clearCoordinatorRoles({ guildId, actorId }) {
    await this.database.query('DELETE FROM guild_policy_coordinator_roles WHERE guild_id=$1', [guildId]);
    await this.database.query('UPDATE guild_policies SET updated_by_discord_user_id=$2,updated_at=now() WHERE guild_id=$1', [guildId, actorId]);
    return this.get(guildId);
  }

  async canPublish({ guildId, permissions, roleIds }) {
    if (isGuildAdmin(permissions)) return true;
    const policy = await this.get(guildId);
    return roleIds?.some((roleId) => policy.coordinatorRoleIds.includes(roleId)) ?? false;
  }
}

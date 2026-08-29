import { hashesEqual, newId, opaqueToken, tokenHash } from './tokens.mjs';

const BROWSER_LINK_TTL_MS = 10 * 60 * 1000;
const BROWSER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STEAM_LINK_TTL_MS = 10 * 60 * 1000;
const OAUTH_AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const OAUTH_ACCESS_TOKEN_TTL_MS = 5 * 60 * 1000;

export class IdentityService {
  constructor({ database, appSecret, now = () => new Date() }) {
    this.database = database;
    this.appSecret = appSecret;
    this.now = now;
  }

  async recordDiscordUser({ discordUserId, displayName, guildId, establishGuild = false }) {
    await this.database.query(
      `INSERT INTO discord_users (discord_user_id, display_name)
       VALUES ($1, $2)
       ON CONFLICT (discord_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()`,
      [discordUserId, displayName ?? null],
    );
    if (guildId && establishGuild) {
      await this.database.query(
        `INSERT INTO guild_installations (guild_id, installed_by_discord_user_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE SET last_seen_at = now()`,
        [guildId, discordUserId],
      );
    }
    if (guildId) await this.database.query(
      `INSERT INTO guild_members (guild_id, discord_user_id)
       SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM guild_installations WHERE guild_id=$1)
       ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET last_seen_at = now()`,
      [guildId, discordUserId],
    );
  }

  async issueBrowserLink({ discordUserId, guildId, guildPermissions = null, guildRoleIds = null }) {
    const token = opaqueToken();
    const expiresAt = new Date(this.now().getTime() + BROWSER_LINK_TTL_MS);
    await this.database.query(
      `INSERT INTO browser_link_tickets (id, token_hash, discord_user_id, guild_id, guild_permissions, guild_role_ids, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(), tokenHash(token, this.appSecret), discordUserId, guildId ?? null, guildPermissions, guildRoleIds ? JSON.stringify(guildRoleIds) : null, expiresAt],
    );
    return { token, expiresAt };
  }

  async redeemBrowserLink(token) {
    const ticket = await this.database.query(
      `UPDATE browser_link_tickets
       SET redeemed_at = now()
       WHERE token_hash = $1 AND redeemed_at IS NULL AND expires_at > now()
       RETURNING discord_user_id, guild_id, guild_permissions, guild_role_ids`,
      [tokenHash(token, this.appSecret)],
    );
    if (!ticket.rowCount) return null;

    const sessionToken = opaqueToken();
    const csrfToken = opaqueToken();
    const expiresAt = new Date(this.now().getTime() + BROWSER_SESSION_TTL_MS);
    await this.database.query(
      `INSERT INTO browser_sessions (id, token_hash, csrf_token_hash, discord_user_id, guild_id, guild_permissions, guild_role_ids, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [newId(), tokenHash(sessionToken, this.appSecret), tokenHash(csrfToken, this.appSecret), ticket.rows[0].discord_user_id, ticket.rows[0].guild_id, ticket.rows[0].guild_permissions, ticket.rows[0].guild_role_ids, expiresAt],
    );
    return { sessionToken, csrfToken, expiresAt, discordUserId: ticket.rows[0].discord_user_id, guildId: ticket.rows[0].guild_id };
  }

  async getBrowserSession(sessionToken) {
    if (!sessionToken) return null;
    const result = await this.database.query(
      `SELECT s.id, s.discord_user_id, s.guild_id, s.guild_permissions, s.guild_role_ids, s.csrf_token_hash, u.display_name
       FROM browser_sessions s
       JOIN discord_users u ON u.discord_user_id = s.discord_user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
      [tokenHash(sessionToken, this.appSecret)],
    );
    return result.rows[0] ?? null;
  }

  async revokeBrowserSession(sessionToken) {
    if (!sessionToken) return;
    await this.database.query('UPDATE browser_sessions SET revoked_at = now() WHERE token_hash = $1', [tokenHash(sessionToken, this.appSecret)]);
  }

  validCsrfToken(session, csrfToken) {
    return Boolean(csrfToken) && hashesEqual(session.csrf_token_hash, tokenHash(csrfToken, this.appSecret));
  }

  async issueOAuthAuthorizationCode({ session, clientId, redirectUri }) {
    if (!session.guild_id) return null;
    const membership = await this.database.query('SELECT 1 FROM guild_members WHERE guild_id=$1 AND discord_user_id=$2', [session.guild_id, session.discord_user_id]);
    if (!membership.rowCount) return null;
    const code = opaqueToken();
    const expiresAt = new Date(this.now().getTime() + OAUTH_AUTHORIZATION_CODE_TTL_MS);
    await this.database.query(
      `INSERT INTO oauth_authorization_codes (id, code_hash, client_id, discord_user_id, guild_id, redirect_uri, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newId(), tokenHash(code, this.appSecret), clientId, session.discord_user_id, session.guild_id, redirectUri, expiresAt],
    );
    return code;
  }

  async redeemOAuthAuthorizationCode({ code, clientId, redirectUri }) {
    const authorization = await this.database.query(
      `UPDATE oauth_authorization_codes SET redeemed_at=now()
       WHERE code_hash=$1 AND client_id=$2 AND redirect_uri=$3 AND redeemed_at IS NULL AND expires_at > now()
       RETURNING discord_user_id, guild_id`,
      [tokenHash(code, this.appSecret), clientId, redirectUri],
    );
    if (!authorization.rowCount) return null;
    const token = opaqueToken();
    const expiresAt = new Date(this.now().getTime() + OAUTH_ACCESS_TOKEN_TTL_MS);
    await this.database.query(
      `INSERT INTO oauth_access_tokens (id, token_hash, client_id, discord_user_id, guild_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newId(), tokenHash(token, this.appSecret), clientId, authorization.rows[0].discord_user_id, authorization.rows[0].guild_id, expiresAt],
    );
    return { token, expiresAt };
  }

  async getOAuthProfile(token) {
    if (!token) return null;
    const result = await this.database.query(
      `SELECT t.discord_user_id, u.display_name FROM oauth_access_tokens t
       JOIN discord_users u ON u.discord_user_id=t.discord_user_id
       JOIN guild_members m ON m.guild_id=t.guild_id AND m.discord_user_id=t.discord_user_id
       WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at > now()`,
      [tokenHash(token, this.appSecret)],
    );
    return result.rows[0] ?? null;
  }

  async createSteamLinkAttempt(discordUserId) {
    const state = opaqueToken();
    const expiresAt = new Date(this.now().getTime() + STEAM_LINK_TTL_MS);
    await this.database.query(
      `INSERT INTO steam_link_attempts (id, state_hash, discord_user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [newId(), tokenHash(state, this.appSecret), discordUserId, expiresAt],
    );
    return { state, expiresAt };
  }

  async consumeSteamLinkAttempt(state, discordUserId) {
    const result = await this.database.query(
      `UPDATE steam_link_attempts
       SET completed_at = now()
       WHERE state_hash = $1 AND discord_user_id = $2 AND completed_at IS NULL AND expires_at > now()
       RETURNING id`,
      [tokenHash(state, this.appSecret), discordUserId],
    );
    return Boolean(result.rowCount);
  }

  async saveSteamConnection(discordUserId, steamId) {
    await this.database.query(
      `INSERT INTO steam_connections (discord_user_id, steam_id, last_sync_status, last_sync_error)
       VALUES ($1, $2, 'pending', NULL)
       ON CONFLICT (discord_user_id) DO UPDATE SET
         steam_id = EXCLUDED.steam_id,
         linked_at = now(),
         last_sync_status = 'pending',
         last_sync_error = NULL`,
      [discordUserId, steamId],
    );
  }

  async getProfile(discordUserId) {
    const result = await this.database.query(
      `SELECT u.discord_user_id, u.display_name, c.steam_id, c.linked_at, c.last_sync_at,
              c.last_sync_status, c.last_sync_error, snapshot.game_count AS last_sync_game_count
       FROM discord_users u
       LEFT JOIN steam_connections c ON c.discord_user_id = u.discord_user_id
       LEFT JOIN LATERAL (
         SELECT game_count FROM ownership_snapshots
         WHERE discord_user_id = u.discord_user_id
         ORDER BY completed_at DESC LIMIT 1
       ) snapshot ON true
       WHERE u.discord_user_id = $1`,
      [discordUserId],
    );
    return result.rows[0] ?? null;
  }

  async getOwnedGames(discordUserId, { page = 1, pageSize = 20 } = {}) {
    const offset = (Math.max(1, page) - 1) * pageSize;
    const [games, count] = await Promise.all([
      this.database.query(
        `SELECT app_id, name, playtime_minutes FROM steam_owned_games
         WHERE discord_user_id=$1 ORDER BY lower(name), app_id LIMIT $2 OFFSET $3`,
        [discordUserId, pageSize, offset],
      ),
      this.database.query('SELECT count(*)::int AS count FROM steam_owned_games WHERE discord_user_id=$1', [discordUserId]),
    ]);
    return { page: Math.max(1, page), total: count.rows[0]?.count ?? 0, games: games.rows.map((game) => ({ appId: game.app_id, name: game.name, playtimeMinutes: game.playtime_minutes })) };
  }

  async recordOwnershipSnapshot({ discordUserId, steamId, result, errorMessage = null }) {
    const status = errorMessage ? 'error' : result.libraryVisible ? 'complete' : 'unavailable';
    const snapshotId = newId();
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO ownership_snapshots (id, discord_user_id, steam_id, status, game_count, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [snapshotId, discordUserId, steamId, status, result?.gameCount ?? null, errorMessage],
      );
      if (status === 'complete') {
        await client.query('DELETE FROM steam_owned_games WHERE discord_user_id = $1', [discordUserId]);
        for (const game of result.games) {
          await client.query(
            `INSERT INTO steam_owned_games (discord_user_id, app_id, name, playtime_minutes, snapshot_id)
             VALUES ($1, $2, $3, $4, $5)`,
            [discordUserId, game.appId, game.name, game.playtimeMinutes, snapshotId],
          );
        }
      }
      await client.query(
        `UPDATE steam_connections SET last_sync_at = now(), last_sync_status = $2, last_sync_error = $3
         WHERE discord_user_id = $1`,
        [discordUserId, status, errorMessage],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return { status, snapshotId };
  }

  async removeSteamConnection(discordUserId) {
    await this.database.query('DELETE FROM steam_connections WHERE discord_user_id = $1', [discordUserId]);
  }

  async deleteDiscordUser(discordUserId) {
    await this.database.query('DELETE FROM discord_users WHERE discord_user_id = $1', [discordUserId]);
  }
}

export const identityTtls = { BROWSER_LINK_TTL_MS, BROWSER_SESSION_TTL_MS, STEAM_LINK_TTL_MS };

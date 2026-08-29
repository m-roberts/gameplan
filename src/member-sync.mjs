const DISCORD_PAGE_SIZE = 1000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

function memberIdentity(member) {
  const user = member?.user;
  if (!user?.id || user.bot) return null;
  return {
    discordUserId: user.id,
    displayName: member.nick ?? user.global_name ?? user.username ?? null,
  };
}

export class DiscordMemberSync {
  constructor({ database, bot, intervalMs = DEFAULT_INTERVAL_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, logger = console }) {
    this.database = database;
    this.bot = bot;
    this.intervalMs = intervalMs;
    this.setInterval = setIntervalImpl;
    this.clearInterval = clearIntervalImpl;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    const run = () => this.syncAll().catch((error) => this.logger.warn(`[discord-members] sync failed: ${error.message}`));
    run();
    this.timer = this.setInterval(run, this.intervalMs);
  }

  stop() {
    if (!this.timer) return;
    this.clearInterval(this.timer);
    this.timer = null;
  }

  async syncAll() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const result = await this.database.query('SELECT guild_id FROM guild_installations ORDER BY guild_id');
      const guilds = await Promise.allSettled(result.rows.map(({ guild_id: guildId }) => this.syncGuild(guildId)));
      const failures = guilds.filter((outcome) => outcome.status === 'rejected');
      for (const failure of failures) this.logger.warn(`[discord-members] guild sync failed: ${failure.reason?.message ?? failure.reason}`);
      return { guilds: guilds.length, failures: failures.length };
    } finally {
      this.running = false;
    }
  }

  async syncGuild(guildId) {
    let after = null;
    let count = 0;
    const seenIds = [];
    for (;;) {
      const members = await this.bot.guildMembers(guildId, { limit: DISCORD_PAGE_SIZE, after });
      if (!Array.isArray(members)) throw new Error(`Discord member list for ${guildId} was not an array`);
      const identities = members.map(memberIdentity).filter(Boolean);
      if (identities.length) {
        const ids = identities.map(({ discordUserId }) => discordUserId);
        const names = identities.map(({ displayName }) => displayName);
        seenIds.push(...ids);
        await this.database.query(
          `WITH incoming AS (
             SELECT * FROM unnest($1::text[], $2::text[]) AS values(discord_user_id, display_name)
           ), upserted AS (
             INSERT INTO discord_users (discord_user_id, display_name)
             SELECT discord_user_id, display_name FROM incoming
             ON CONFLICT (discord_user_id) DO UPDATE
               SET display_name = coalesce(EXCLUDED.display_name, discord_users.display_name), updated_at = now()
             RETURNING discord_user_id
           )
           INSERT INTO guild_members (guild_id, discord_user_id)
           SELECT $3, discord_user_id FROM upserted
           ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET last_seen_at = now()`,
          [ids, names, guildId],
        );
        count += identities.length;
      }
      if (members.length < DISCORD_PAGE_SIZE) break;
      const nextAfter = members.at(-1)?.user?.id;
      if (!nextAfter || nextAfter === after) throw new Error(`Discord member pagination did not advance for ${guildId}`);
      after = nextAfter;
    }
    await this.database.query(
      'DELETE FROM guild_members WHERE guild_id=$1 AND NOT (discord_user_id = ANY($2::text[]))',
      [guildId, seenIds],
    );
    return count;
  }
}

export { DEFAULT_INTERVAL_MS };

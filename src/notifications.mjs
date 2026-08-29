import { newId } from './tokens.mjs';

export const DELIVERY_OPTIONS = ['off', 'dm', 'thread', 'both'];
export const REMINDER_LEADS = [15, 60, 1440];

function validDelivery(value) { return DELIVERY_OPTIONS.includes(value) ? value : null; }
function validLeads(values) {
  if (!Array.isArray(values) || values.some((value) => !REMINDER_LEADS.includes(Number(value)))) return null;
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}
function validTime(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
function validTimezone(value) { try { new Intl.DateTimeFormat('en-GB', { timeZone: value }); return true; } catch { return false; } }
function localMinutes(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find((part) => part.type === 'hour').value) * 60 + Number(parts.find((part) => part.type === 'minute').value);
}
function timeMinutes(value) { const [hour, minute] = value.split(':').map(Number); return hour * 60 + minute; }

export function isQuietNow({ timezone, quietStart, quietEnd }, now = new Date()) {
  if (!quietStart || !quietEnd) return false;
  const current = localMinutes(timezone, now); const start = timeMinutes(quietStart); const end = timeMinutes(quietEnd);
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function nextAllowedAt(settings, now = new Date()) {
  for (let minute = 1; minute <= 24 * 60; minute += 1) {
    const candidate = new Date(now.getTime() + minute * 60_000);
    if (!isQuietNow(settings, candidate)) return candidate;
  }
  return new Date(now.getTime() + 60 * 60_000);
}

export class NotificationService {
  constructor({ database, now = () => new Date() }) { this.database = database; this.now = now; }

  async getSettings({ guildId, discordUserId }) {
    const result = await this.database.query(
      `SELECT coalesce(u.timezone, 'Europe/London') AS timezone, u.quiet_start::text, u.quiet_end::text,
              coalesce(p.reminder_delivery, 'off') AS reminder_delivery,
              coalesce(p.reminder_lead_minutes, ARRAY[60]::INTEGER[]) AS reminder_lead_minutes,
              coalesce(p.lfg_alert_delivery, 'off') AS lfg_alert_delivery,
              coalesce(p.game_night_change_delivery, 'dm') AS game_night_change_delivery
       FROM (SELECT $1::text AS guild_id, $2::text AS discord_user_id) input
       LEFT JOIN discord_user_notification_settings u ON u.discord_user_id=input.discord_user_id
       LEFT JOIN guild_notification_preferences p ON p.guild_id=input.guild_id AND p.discord_user_id=input.discord_user_id`,
      [guildId, discordUserId],
    );
    const row = result.rows[0];
    const muted = await this.database.query(
      `SELECT m.steam_app_id, coalesce(g.name, 'Steam app ' || m.steam_app_id::text) AS name
       FROM game_notification_mutes m LEFT JOIN steam_owned_games g ON g.discord_user_id=m.discord_user_id AND g.app_id=m.steam_app_id
       WHERE m.discord_user_id=$1 ORDER BY lower(coalesce(g.name, ''))`, [discordUserId],
    );
    return {
      timezone: row.timezone, quietStart: row.quiet_start?.slice(0, 5) ?? null, quietEnd: row.quiet_end?.slice(0, 5) ?? null,
      reminderDelivery: row.reminder_delivery, reminderLeadMinutes: row.reminder_lead_minutes,
      lfgAlertDelivery: row.lfg_alert_delivery,
      gameNightChangeDelivery: row.game_night_change_delivery,
      mutedGames: muted.rows.map((game) => ({ appId: game.steam_app_id, name: game.name })),
    };
  }

  async saveSettings({ guildId, discordUserId, timezone, quietStart, quietEnd, reminderDelivery, reminderLeadMinutes, lfgAlertDelivery, gameNightChangeDelivery = 'dm' }) {
    if (!validTimezone(timezone)) throw new Error('Choose a valid IANA timezone, such as Europe/London.');
    if ((quietStart || quietEnd) && (!validTime(quietStart) || !validTime(quietEnd) || quietStart === quietEnd)) throw new Error('Quiet hours need different start and end times in HH:MM format, or leave both empty.');
    const leads = validLeads(reminderLeadMinutes); const reminder = validDelivery(reminderDelivery); const lfg = validDelivery(lfgAlertDelivery); const gameNightChange = validDelivery(gameNightChangeDelivery);
    if (!leads || !reminder || !lfg || !gameNightChange) throw new Error('Choose valid notification settings.');
    await this.database.query(
      `INSERT INTO discord_user_notification_settings (discord_user_id, timezone, quiet_start, quiet_end)
       VALUES ($1,$2,$3,$4) ON CONFLICT (discord_user_id) DO UPDATE SET timezone=EXCLUDED.timezone,quiet_start=EXCLUDED.quiet_start,quiet_end=EXCLUDED.quiet_end,updated_at=now()`,
      [discordUserId, timezone, quietStart || null, quietEnd || null],
    );
    await this.database.query(
      `INSERT INTO guild_notification_preferences (guild_id, discord_user_id, reminder_delivery, reminder_lead_minutes, lfg_alert_delivery, game_night_change_delivery)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (guild_id,discord_user_id) DO UPDATE SET reminder_delivery=EXCLUDED.reminder_delivery,reminder_lead_minutes=EXCLUDED.reminder_lead_minutes,lfg_alert_delivery=EXCLUDED.lfg_alert_delivery,game_night_change_delivery=EXCLUDED.game_night_change_delivery,updated_at=now()`,
      [guildId, discordUserId, reminder, leads, lfg, gameNightChange],
    );
    return this.getSettings({ guildId, discordUserId });
  }

  async muteGame({ guildId, discordUserId, appId }) {
    if (!Number.isInteger(Number(appId)) || Number(appId) <= 0) throw new Error('Choose a Steam game to mute.');
    await this.database.query('INSERT INTO game_notification_mutes (discord_user_id,steam_app_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [discordUserId, Number(appId)]);
    return this.getSettings({ guildId, discordUserId });
  }

  async unmuteGame({ guildId, discordUserId, appId }) {
    await this.database.query('DELETE FROM game_notification_mutes WHERE discord_user_id=$1 AND steam_app_id=$2', [discordUserId, Number(appId)]);
    return this.getSettings({ guildId, discordUserId });
  }

  async queueOwnershipAlerts(session) {
    const recipients = await this.database.query(
      `SELECT p.discord_user_id, p.lfg_alert_delivery
       FROM guild_notification_preferences p
       JOIN steam_connections c ON c.discord_user_id=p.discord_user_id AND c.last_sync_status='complete'
       JOIN steam_owned_games g ON g.discord_user_id=p.discord_user_id AND g.app_id=$2
       WHERE p.guild_id=$1 AND p.lfg_alert_delivery <> 'off'
         AND NOT EXISTS (SELECT 1 FROM game_notification_mutes m WHERE m.discord_user_id=p.discord_user_id AND m.steam_app_id=$2)
         AND NOT EXISTS (SELECT 1 FROM session_rsvps r WHERE r.game_session_id=$3 AND r.discord_user_id=p.discord_user_id AND r.response='accepted')`,
      [session.guildId, session.game.appId, session.id],
    );
    await Promise.all(recipients.rows.map((recipient) => this.createDelivery({
      kind: 'lfg_ownership_alert', dedupeKey: `lfg:${session.id}:${recipient.discord_user_id}`, guildId: session.guildId,
      discordUserId: recipient.discord_user_id, sessionId: session.id, delivery: recipient.lfg_alert_delivery,
      expectedStartsAt: session.startsAt, scheduledAt: this.now(), leadMinutes: null,
    })));
  }

  async reconcileReminders() {
    const candidates = await this.database.query(
      `SELECT s.id, s.guild_id, s.starts_at, r.discord_user_id, p.reminder_delivery, p.reminder_lead_minutes
       FROM game_sessions s JOIN session_rsvps r ON r.game_session_id=s.id AND r.response='accepted'
       JOIN guild_notification_preferences p ON p.guild_id=s.guild_id AND p.discord_user_id=r.discord_user_id
       WHERE s.cancelled_at IS NULL AND s.starts_at > now() AND p.reminder_delivery <> 'off' AND s.starts_at < now() + interval '31 days'`,
    );
    await Promise.all(candidates.rows.flatMap((row) => row.reminder_lead_minutes.map((leadMinutes) => {
      const scheduledAt = new Date(new Date(row.starts_at).getTime() - leadMinutes * 60_000);
      if (scheduledAt <= this.now()) return null;
      return this.createDelivery({ kind: 'session_reminder', dedupeKey: `reminder:${row.id}:${row.discord_user_id}:${leadMinutes}:${new Date(row.starts_at).toISOString()}`, guildId: row.guild_id, discordUserId: row.discord_user_id, sessionId: row.id, delivery: row.reminder_delivery, expectedStartsAt: row.starts_at, scheduledAt, leadMinutes });
    }).filter(Boolean)));
  }

  async queueGameNightChange({ session, content, changeKey }) {
    const recipients = await this.database.query(
      `WITH eligible AS (
         SELECT host_discord_user_id AS discord_user_id FROM game_sessions WHERE id=$1
         UNION
         SELECT discord_user_id FROM session_rsvps WHERE game_session_id=$1
         UNION
         SELECT discord_user_id FROM session_live_statuses WHERE game_session_id=$1 AND status IN ('here', 'joining_next_game')
       )
       SELECT e.discord_user_id, coalesce(p.game_night_change_delivery, 'dm') AS delivery
       FROM eligible e
       LEFT JOIN guild_notification_preferences p ON p.guild_id=$2 AND p.discord_user_id=e.discord_user_id
       WHERE coalesce(p.game_night_change_delivery, 'dm') <> 'off'`,
      [session.id, session.guildId],
    );
    await Promise.all(recipients.rows.map((recipient) => this.createDelivery({
      kind: 'game_night_change', dedupeKey: `game-night-change:${session.id}:${changeKey}:${recipient.discord_user_id}`,
      guildId: session.guildId, discordUserId: recipient.discord_user_id, sessionId: session.id,
      delivery: recipient.delivery, expectedStartsAt: session.startsAt, scheduledAt: this.now(), leadMinutes: null, content,
    })));
  }

  async createDelivery({ kind, dedupeKey, guildId, discordUserId, sessionId, delivery, expectedStartsAt, scheduledAt, leadMinutes, content = null }) {
    await this.database.query(
      `INSERT INTO notification_deliveries (id,dedupe_key,kind,guild_id,discord_user_id,game_session_id,delivery,lead_minutes,expected_starts_at,scheduled_at,content)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) DO NOTHING`,
      [newId(), dedupeKey, kind, guildId, discordUserId, sessionId, delivery, leadMinutes, expectedStartsAt, scheduledAt, content],
    );
  }

  async claimDue(limit = 50) {
    const claimed = await this.database.query(
      `WITH due AS (SELECT id FROM notification_deliveries WHERE status='pending' AND scheduled_at <= now() ORDER BY scheduled_at FOR UPDATE SKIP LOCKED LIMIT $1)
       UPDATE notification_deliveries d SET status='sending',attempted_at=now(),attempt_count=attempt_count+1 FROM due WHERE d.id=due.id RETURNING d.*`, [limit],
    );
    return claimed.rows;
  }

  async finish(id, { status, failureReason = null }) {
    await this.database.query(`UPDATE notification_deliveries SET status=$2,delivered_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END,failure_reason=$3 WHERE id=$1`, [id, status, failureReason]);
  }

  async defer(id, scheduledAt) { await this.database.query(`UPDATE notification_deliveries SET status='pending',scheduled_at=$2,attempted_at=NULL,failure_reason='Delayed for quiet hours' WHERE id=$1`, [id, scheduledAt]); }

  async retry(id, failureReason) {
    await this.database.query(`UPDATE notification_deliveries SET status='pending',scheduled_at=now() + interval '5 minutes',attempted_at=NULL,failure_reason=$2 WHERE id=$1`, [id, failureReason]);
  }

  async validateDelivery(job) {
    const session = await this.database.query(
      `SELECT s.id,s.guild_id,s.game_name,s.starts_at,s.cancelled_at,r.response,p.discussion_thread_id,
              coalesce(u.timezone,'Europe/London') AS timezone,u.quiet_start::text,u.quiet_end::text,
              gp.reminder_delivery,gp.reminder_lead_minutes,gp.lfg_alert_delivery,coalesce(gp.game_night_change_delivery,'dm') AS game_night_change_delivery,
              EXISTS (SELECT 1 FROM steam_owned_games g WHERE g.discord_user_id=$2 AND g.app_id=s.steam_app_id) AS owns_game,
              EXISTS (SELECT 1 FROM game_notification_mutes m WHERE m.discord_user_id=$2 AND m.steam_app_id=s.steam_app_id) AS muted
       FROM game_sessions s LEFT JOIN session_rsvps r ON r.game_session_id=s.id AND r.discord_user_id=$2
       LEFT JOIN session_lfg_posts p ON p.game_session_id=s.id
       LEFT JOIN discord_user_notification_settings u ON u.discord_user_id=$2
       LEFT JOIN guild_notification_preferences gp ON gp.guild_id=s.guild_id AND gp.discord_user_id=$2
       WHERE s.id=$1`, [job.game_session_id, job.discord_user_id],
    );
    const row = session.rows[0];
    if (!row || row.cancelled_at) return null;
    const settings = { timezone: row.timezone, quietStart: row.quiet_start?.slice(0, 5), quietEnd: row.quiet_end?.slice(0, 5) };
    if (job.kind === 'session_reminder' && (row.response !== 'accepted' || row.reminder_delivery !== job.delivery || !row.reminder_lead_minutes?.includes(job.lead_minutes))) return null;
    if (job.kind === 'lfg_ownership_alert' && (!row.owns_game || row.muted || row.response === 'accepted' || row.lfg_alert_delivery !== job.delivery)) return null;
    if (job.kind === 'game_night_change' && row.game_night_change_delivery !== job.delivery) return null;
    if (job.kind !== 'game_night_change' && (new Date(row.starts_at) <= this.now() || new Date(row.starts_at).getTime() !== new Date(job.expected_starts_at).getTime())) return null;
    return { ...row, settings };
  }
}

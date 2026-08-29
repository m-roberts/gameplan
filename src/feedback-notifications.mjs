import { newId } from './tokens.mjs';

// GamePlan deliberately supplies Fider with an opaque, synthetic address rather
// than a person's email. This is the stable identity carried back in Fider's
// standard webhook properties.
const fiderIdentity = /^discord-([0-9]{5,32})@users\.gameplan\.invalid$/;
export function discordUserFromFiderIdentity(value) { return fiderIdentity.exec(value ?? '')?.[1] ?? null; }

export class FeedbackNotificationService {
  constructor({ database }) { this.database = database; }
  enabled() { return true; }
  async getSettings(discordUserId) {
    const r = await this.database.query(`SELECT coalesce(owner_updates_enabled,true) owner_updates_enabled, coalesce(participant_updates_enabled,true) participant_updates_enabled FROM feedback_notification_preferences WHERE discord_user_id=$1`, [discordUserId]);
    return { ownerUpdatesEnabled: r.rows[0]?.owner_updates_enabled ?? true, participantUpdatesEnabled: r.rows[0]?.participant_updates_enabled ?? true };
  }
  async saveSettings(discordUserId, { ownerUpdatesEnabled, participantUpdatesEnabled }) {
    if (typeof ownerUpdatesEnabled !== 'boolean' || typeof participantUpdatesEnabled !== 'boolean') throw new Error('Feedback notification preferences must be true or false');
    await this.database.query(`INSERT INTO feedback_notification_preferences (discord_user_id,owner_updates_enabled,participant_updates_enabled) VALUES ($1,$2,$3) ON CONFLICT (discord_user_id) DO UPDATE SET owner_updates_enabled=EXCLUDED.owner_updates_enabled,participant_updates_enabled=EXCLUDED.participant_updates_enabled,updated_at=now()`, [discordUserId, Boolean(ownerUpdatesEnabled), Boolean(participantUpdatesEnabled)]);
    return this.getSettings(discordUserId);
  }
  async receive(event) {
    if (!['new_comment', 'change_status'].includes(event.type)) throw new Error('Unsupported Fider webhook event');
    if (!Number.isInteger(event.post_number) || event.post_number < 1 || typeof event.post_title !== 'string' || typeof event.post_url !== 'string') throw new Error('Fider event is missing post details');
    const owner = discordUserFromFiderIdentity(event.post_author_email);
    const author = discordUserFromFiderIdentity(event.author_email);
    if (!owner) throw new Error('Fider event has no valid GamePlan post author identity');
    const key = `${event.type}:${event.post_number}:${event.comment_id ?? event.post_status}:${event.post_response_at ?? ''}`;
    const seen = await this.database.query('INSERT INTO feedback_event_receipts (event_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_key', [key]);
    if (!seen.rowCount) return { duplicate: true };
    if (event.type === 'new_comment' && author) await this.database.query('INSERT INTO feedback_ticket_participants (ticket_number,discord_user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [event.post_number, author]);
    const recipients = await this.database.query(`
      WITH recipients AS (
        SELECT $1::text AS discord_user_id, 'owner' AS role
        UNION
        SELECT discord_user_id, 'participant' AS role
        FROM feedback_ticket_participants WHERE ticket_number=$2
      )
      SELECT DISTINCT r.discord_user_id
      FROM recipients r
      LEFT JOIN feedback_notification_preferences p ON p.discord_user_id=r.discord_user_id
      WHERE (r.role='owner' AND coalesce(p.owner_updates_enabled,true))
         OR (r.role='participant' AND coalesce(p.participant_updates_enabled,true))
    `, [owner, event.post_number]);
    const text = event.type === 'change_status' ? `Your feedback **${event.post_title}** is now **${event.post_status}**.\n${event.post_url}` : `New reply on **${event.post_title}**:\n${event.comment}\n${event.post_url}`;
    await Promise.all(recipients.rows.filter((r) => r.discord_user_id !== author).map((r) => this.database.query(`INSERT INTO feedback_notification_deliveries (id,dedupe_key,discord_user_id,kind,ticket_number,ticket_title,ticket_url,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`, [newId(), `${key}:${r.discord_user_id}`, r.discord_user_id, event.type === 'change_status' ? 'feedback_status' : 'feedback_comment', event.post_number, event.post_title, event.post_url, text])));
    return { duplicate: false };
  }
}

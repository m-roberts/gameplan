import { loadConfig } from './config.mjs';
import { createDatabase } from './database.mjs';
import { DiscordBot } from './discord-bot.mjs';
import { lfgCard, rallyCard } from './discord-bot.mjs';
import { postSessionActivity, publishLfg } from './lfg-discussion.mjs';
import { nextAllowedAt, isQuietNow, NotificationService } from './notifications.mjs';
import { PlannerService } from './planner.mjs';
import { RallyService } from './rallies.mjs';

const config = loadConfig();
const database = createDatabase(config.databaseUrl);
const bot = new DiscordBot({ token: config.discordBotToken });
const notifications = new NotificationService({ database });
const planner = new PlannerService({ database });
const rallies = new RallyService({ database, planner });

function mention(userId, content) {
  return { content: `<@${userId}> ${content}`, allowed_mentions: { parse: [], users: [userId] } };
}

async function sendDelivery(job, session) {
  const reminder = job.kind === 'session_reminder';
  const content = job.kind === 'game_night_change'
    ? `${job.content}\n\nJoin the discussion: https://discord.com/channels/${session.guild_id}/${session.discussion_thread_id}`
    : reminder
    ? `**${session.game_name}** starts in ${job.lead_minutes >= 60 ? `${job.lead_minutes / 60} hour${job.lead_minutes === 60 ? '' : 's'}` : `${job.lead_minutes} minutes`}.`
    : `A new GamePlan session for **${session.game_name}** was published in the Session Feed. You own this game.`;
  let delivered = false; let failure = null;
  if (job.delivery === 'dm' || job.delivery === 'both') {
    try { await bot.dm(job.discord_user_id, { content }); delivered = true; } catch (error) { failure = error.message; }
  }
  if ((job.delivery === 'thread' || job.delivery === 'both' || !delivered) && session.discussion_thread_id) {
    try { await bot.send(session.discussion_thread_id, mention(job.discord_user_id, content)); delivered = true; } catch (error) { failure = failure ?? error.message; }
  }
  return { delivered, failure };
}

async function tick() {
  await planner.materializeRegularGameNights();
  const readyForFeed = await planner.listRegularGameNightsReadyForFeed();
  for (const occurrence of readyForFeed) {
    try {
      const session = await planner.getSession(occurrence.id, occurrence.host_discord_user_id);
      if (session) await publishLfg({ session, channelId: occurrence.default_lfg_channel_id, bot, database, notifications });
    } catch (error) { console.warn(`Could not publish regular Game Night ${occurrence.id} to the Session Feed: ${error.message}`); }
  }
  const feedbackJobs = await database.query(`WITH due AS (SELECT id FROM feedback_notification_deliveries WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 50) UPDATE feedback_notification_deliveries d SET status='sending',attempted_at=now() FROM due WHERE d.id=due.id RETURNING d.*`);
  for (const job of feedbackJobs.rows) {
    try { await bot.dm(job.discord_user_id, { content: job.content }); await database.query("UPDATE feedback_notification_deliveries SET status='delivered',delivered_at=now() WHERE id=$1", [job.id]); }
    catch (error) { await database.query("UPDATE feedback_notification_deliveries SET status='failed',failure_reason=$2 WHERE id=$1", [job.id, error.message]); }
  }
  const expiredRallies = await rallies.expireRallies();
  for (const expired of expiredRallies) {
    const rally = await rallies.get(expired.id, expired.host_discord_user_id);
    const post = await database.query('SELECT * FROM rally_posts WHERE rally_id=$1', [expired.id]);
    if (rally && post.rowCount) {
      try { await bot.edit(post.rows[0].channel_id, post.rows[0].message_id, rallyCard(rally)); } catch (error) { console.warn(`Could not archive expired GamePlan game vote: ${error.message}`); }
    }
  }
  const started = await planner.closeStartedSessions();
  for (const startedSession of started) {
    const session = await planner.getSession(startedSession.id, startedSession.host_discord_user_id);
    const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [startedSession.id]);
    if (session && post.rowCount) {
      try { await bot.edit(post.rows[0].channel_id, post.rows[0].message_id, lfgCard(session, { discussionThreadId: post.rows[0].discussion_thread_id })); } catch (error) { console.warn(`Could not close GamePlan Session Feed joins: ${error.message}`); }
      await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: 'This session is now underway; new joins are closed.', notifyDiscordUserIds: session.rsvps.filter((r) => r.response === 'accepted').map((r) => r.discordUserId) });
    }
  }
  await notifications.reconcileReminders();
  const jobs = await notifications.claimDue();
  for (const job of jobs) {
    const session = await notifications.validateDelivery(job);
    if (!session) { await notifications.finish(job.id, { status: 'skipped', failureReason: 'No longer eligible' }); continue; }
    if (isQuietNow(session.settings)) {
      await notifications.defer(job.id, nextAllowedAt(session.settings));
      continue;
    }
    const result = await sendDelivery(job, session);
    if (result.delivered) await notifications.finish(job.id, { status: 'delivered' });
    else if (job.attempt_count < 3) await notifications.retry(job.id, result.failure ?? 'No usable Discord delivery route');
    else await notifications.finish(job.id, { status: 'failed', failureReason: result.failure ?? 'No usable Discord delivery route' });
  }
}

let stopping = false;
async function loop() {
  while (!stopping) {
    try { await tick(); } catch (error) { console.error('Notification worker tick failed', error); }
    await new Promise((resolve) => setTimeout(resolve, 60_000));
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
loop().finally(() => database.close());

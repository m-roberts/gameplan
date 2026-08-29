import { lfgCard } from './discord-bot.mjs';

function confirmed(session) {
  return session.rsvps.filter((rsvp) => rsvp.response === 'accepted');
}

function mentionList(discordUserIds) {
  return [...new Set(discordUserIds)].filter(Boolean).slice(0, 100);
}

function mentionText(discordUserIds) {
  return mentionList(discordUserIds).map((discordUserId) => `<@${discordUserId}>`).join(' ');
}

function notification(content, discordUserIds = []) {
  const users = mentionList(discordUserIds);
  return {
    content: `${mentionText(users)}${users.length ? ' ' : ''}${content}`,
    allowed_mentions: { parse: [], users },
  };
}

export function lfgThreadName(session) {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(session.startsAt));
  const suffix = ` · ${when} · #${session.id.slice(-6)}`;
  return `GamePlan · ${session.game.title.slice(0, Math.max(1, 100 - suffix.length - 12))}${suffix}`;
}

export function discussionOpening(session) {
  const roster = confirmed(session);
  const gamesTonight = session.gamesTonight?.length
    ? `\n\n**Games Tonight**\n${session.gamesTonight.map((game) => `${game.status === 'now_playing' ? '**Now playing**' : game.status === 'up_next' ? '**Up next**' : game.status.replaceAll('_', ' ')} · ${game.title}${game.note ? ` — ${game.note}` : ''}`).join('\n')}`
    : '';
  return notification(
    `**${session.game.title}** is planned for ${new Date(session.startsAt).toLocaleString()}.\n\nConfirmed: ${roster.map((rsvp) => rsvp.displayName).join(', ') || 'nobody yet'}${gamesTonight}\n\nUse this thread to coordinate.`,
    roster.map((rsvp) => rsvp.discordUserId),
  );
}

export function sessionActivity({ content, notifyDiscordUserIds }) {
  return notification(content, notifyDiscordUserIds);
}

export async function publishLfg({ session, channelId, bot, database, notifications = null }) {
  const message = await bot.send(channelId, lfgCard(session));
  const thread = await bot.thread(channelId, message.id, lfgThreadName(session));
  await database.query(
    `INSERT INTO session_lfg_posts (game_session_id, guild_id, channel_id, message_id, discussion_thread_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (game_session_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,discussion_thread_id=EXCLUDED.discussion_thread_id,published_at=now()`,
    [session.id, session.guildId, channelId, message.id, thread.id],
  );
  await bot.edit(channelId, message.id, lfgCard(session, { discussionThreadId: thread.id }));
  await postSessionActivity({ threadId: thread.id, bot, ...discussionOpening(session) });
  await notifications?.queueOwnershipAlerts(session);
  return { message, thread };
}

export async function createLfgDiscussion({ session, post, bot, database }) {
  const existingThreadId = post.rows[0].discussion_thread_id;
  if (existingThreadId) return { id: existingThreadId };
  const thread = await bot.thread(post.rows[0].channel_id, post.rows[0].message_id, lfgThreadName(session));
  await database.query('UPDATE session_lfg_posts SET discussion_thread_id=$2 WHERE game_session_id=$1', [session.id, thread.id]);
  await bot.edit(post.rows[0].channel_id, post.rows[0].message_id, lfgCard(session, { discussionThreadId: thread.id }));
  await postSessionActivity({ threadId: thread.id, bot, ...discussionOpening(session) });
  return thread;
}

export async function updateLfgCard({ session, post, bot }) {
  if (!post?.rowCount) return;
  if (post.rows[0].discussion_thread_id) {
    try { await bot.renameThread(post.rows[0].discussion_thread_id, lfgThreadName(session)); } catch (error) { console.warn(`Could not rename GamePlan discussion: ${error.message}`); }
  }
  await bot.edit(post.rows[0].channel_id, post.rows[0].message_id, lfgCard(session, { discussionThreadId: post.rows[0].discussion_thread_id }));
}

export async function postSessionActivity({ threadId, bot, content, notifyDiscordUserIds, allowed_mentions }) {
  if (!threadId) return;
  try {
    await bot.send(threadId, allowed_mentions ? { content, allowed_mentions } : sessionActivity({ content, notifyDiscordUserIds }));
  } catch (error) {
    console.warn(`Could not post GamePlan session activity: ${error.message}`);
  }
}

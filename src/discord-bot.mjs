const API = 'https://discord.com/api/v10';
import { currentDiscordTraceId } from './discord-trace.mjs';

const ADMINISTRATOR = 1n << 3n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;

function bitfield(value) { return BigInt(value ?? '0'); }

function applyOverwrite(permissions, overwrite) {
  return (permissions & ~bitfield(overwrite.deny)) | bitfield(overwrite.allow);
}

export function guildPermissionsForMember({ guildId, roles, member }) {
  const roleIds = new Set(member.roles ?? []);
  return roles
    .filter((role) => role.id === guildId || roleIds.has(role.id))
    .reduce((value, role) => value | bitfield(role.permissions), 0n);
}

function channelPermissions({ channel, guildId, roles, member }) {
  const roleIds = new Set(member.roles ?? []);
  let permissions = guildPermissionsForMember({ guildId, roles, member });
  if (permissions & ADMINISTRATOR) return permissions;

  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === guildId);
  if (everyone) permissions = applyOverwrite(permissions, everyone);

  const roleOverwrites = overwrites.filter((overwrite) => overwrite.type === 0 && roleIds.has(overwrite.id));
  if (roleOverwrites.length) {
    permissions &= ~roleOverwrites.reduce((value, overwrite) => value | bitfield(overwrite.deny), 0n);
    permissions |= roleOverwrites.reduce((value, overwrite) => value | bitfield(overwrite.allow), 0n);
  }

  const memberOverwrite = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === member.user?.id);
  if (memberOverwrite) permissions = applyOverwrite(permissions, memberOverwrite);
  return permissions;
}

export function canViewChannel(context) {
  return Boolean(channelPermissions(context) & VIEW_CHANNEL);
}

export function canPostInChannel({ channel, guildId, roles, member }) {
  const permissions = channelPermissions({ channel, guildId, roles, member });
  return channel.type === 0 && Boolean((permissions & VIEW_CHANNEL) && (permissions & SEND_MESSAGES));
}

export class DiscordBot {
  constructor({ token, fetchImpl = fetch, trace = null }) { this.token = token; this.fetch = fetchImpl; this.trace = trace; }
  async recordTrace(event) {
    if (!this.trace) return;
    try { await this.trace({ traceId: currentDiscordTraceId(), ...event }); } catch (error) { console.error('[discord-trace] record failed', error); }
  }
  async request(path, { method = 'GET', body } = {}) {
    if (!this.token) throw new Error('Discord bot token is not configured.');
    const started = Date.now();
    const response = await this.fetch(`${API}${path}`, { method, headers: { authorization: `Bot ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const responseText = response.status === 204 ? '' : await response.clone().text();
    await this.recordTrace({ direction: 'outbound', eventType: 'discord-api', method, path, status: response.status, requestBody: body ?? null, responseText, durationMs: Date.now() - started });
    if (!response.ok) throw new Error(`Discord API returned HTTP ${response.status}${responseText ? `: ${responseText}` : ''}`);
    return response.status === 204 ? null : response.json();
  }
  currentUser() { return this.request('/users/@me'); }
  guild(guildId) { return this.request(`/guilds/${guildId}`); }
  channels(guildId) { return this.request(`/guilds/${guildId}/channels`); }
  roles(guildId) { return this.request(`/guilds/${guildId}/roles`); }
  async currentGuildMember(guildId) { const user = await this.currentUser(); return this.guildMember(guildId, user.id); }
  guildMember(guildId, userId) { return this.request(`/guilds/${guildId}/members/${userId}`); }
  guildMembers(guildId, { limit = 1000, after = null } = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(1000, Math.max(1, limit))) });
    if (after) params.set('after', after);
    return this.request(`/guilds/${guildId}/members?${params}`);
  }
  async memberAuthority(guildId, userId) {
    const [roles, member, guild] = await Promise.all([this.roles(guildId), this.guildMember(guildId, userId), this.guild(guildId)]);
    const permissions = guild.owner_id === userId
      ? guildPermissionsForMember({ guildId, roles, member }) | ADMINISTRATOR
      : guildPermissionsForMember({ guildId, roles, member });
    return { permissions: String(permissions), roleIds: member.roles ?? [] };
  }
  async sendableTextChannels(guildId) {
    const [channels, roles, member] = await Promise.all([this.channels(guildId), this.roles(guildId), this.currentGuildMember(guildId)]);
    return channels.filter((channel) => canPostInChannel({ channel, guildId, roles, member }));
  }
  async visibleVoiceChannels(guildId) {
    const [channels, roles, member] = await Promise.all([this.channels(guildId), this.roles(guildId), this.currentGuildMember(guildId)]);
    return channels.filter((channel) => channel.type === 2 && canViewChannel({ channel, guildId, roles, member }));
  }
  send(channelId, body) { return this.request(`/channels/${channelId}/messages`, { method: 'POST', body }); }
  edit(channelId, messageId, body) { return this.request(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body }); }
  async editInteractionResponse(interaction, body) {
    if (!interaction.application_id || !interaction.token) throw new Error('Discord interaction is missing its application ID or token.');
    const { flags: _flags, ...editBody } = body;
    if (typeof editBody.content === 'string' && editBody.content.length > 2000) {
      const notice = '… [Truncated]. Use the GamePlan web UI for the full experience.';
      editBody.content = `${editBody.content.slice(0, 2000 - notice.length)}${notice}`;
    }
    const path = `/webhooks/${interaction.application_id}/<interaction-token>/messages/@original`;
    const started = Date.now();
    const response = await this.fetch(`${API}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(editBody),
    });
    const detail = response.status === 204 ? '' : await response.clone().text();
    await this.recordTrace({ direction: 'outbound', eventType: 'discord-interaction-edit', interactionId: interaction.id, method: 'PATCH', path, status: response.status, requestBody: editBody, responseText: detail, durationMs: Date.now() - started });
    if (!response.ok) {
      throw new Error(`Discord interaction response returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return response.status === 204 ? null : response.json();
  }
  renameThread(threadId, name) { return this.request(`/channels/${threadId}`, { method: 'PATCH', body: { name } }); }
  async dm(userId, body) { const channel = await this.request('/users/@me/channels', { method: 'POST', body: { recipient_id: userId } }); return this.send(channel.id, body); }
  thread(channelId, messageId, name) { return this.request(`/channels/${channelId}/messages/${messageId}/threads`, { method: 'POST', body: { name, auto_archive_duration: 1440 } }); }
}

export function sessionEmbed(session) {
  return { embeds: [{ title: session.game.title, description: session.hostNote || 'GamePlan session', fields: [{ name: 'Starts', value: new Date(session.startsAt).toLocaleString(), inline: true }, { name: 'RSVPs', value: session.rsvps.map((r) => `${r.displayName}: ${r.response}`).join('\n') || 'None' }], footer: { text: 'GamePlan' } }] };
}
export function inviteCard(session) {
  return {
    content: 'You’re invited to a GamePlan session.',
    ...sessionEmbed(session),
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: 'Accept', custom_id: `rsvp:${session.id}:accepted` },
      { type: 2, style: 4, label: 'Decline', custom_id: `rsvp:${session.id}:declined` },
      { type: 2, style: 5, label: 'Details', url: session.browserUrl },
      { type: 2, style: 2, label: 'How it works', custom_id: 'onboard:help' },
    ] }],
  };
}

export function discussionUrl(guildId, threadId) {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

export function lfgCard(session, { discussionThreadId } = {}) {
  const card = sessionEmbed(session);
  const confirmed = session.rsvps.filter((r) => r.response === 'accepted');
  const max = session.game.maxPlayers;
  const capacity = max
    ? `${confirmed.length}/${max} confirmed · ${Math.max(0, max - confirmed.length)} slots left`
    : `${confirmed.length} confirmed · no group limit set`;
  const note = session.hostNote ? `${session.hostNote}\n\n` : '';
  const underway = Boolean(session.registrationClosedAt);
  card.embeds[0].description = `${note}${underway ? '**This session is underway.** New joins are closed.' : `**Joining:** ${session.game.requiresAllOwners === false ? 'this game only needs one owner; anyone can claim an open slot.' : 'link Steam and sync a visible library that owns this game.'}`}`;
  const roster = confirmed
    .map((r) => `• ${r.displayName}${r.discordUserId === session.hostDiscordUserId ? ' (Host)' : ''}`)
    .join('\n') || 'No confirmed players';
  const here = session.rsvps.filter((r) => r.liveStatus === 'here').map((r) => `• ${r.displayName}`).join('\n') || 'Nobody marked here yet';
  const expected = session.rsvps.filter((r) => r.response === 'accepted' && r.liveStatus !== 'here').map((r) => `• ${r.displayName}${r.liveStatus === 'running_late' ? ' · running late' : r.liveStatus === 'leaving' ? ' · leaving' : ''}`).join('\n') || 'Nobody else expected';
  card.embeds[0].fields.push(
    { name: 'Roster', value: `${capacity}\n${roster}` },
    { name: 'Here now', value: here, inline: true },
    { name: 'Expected', value: expected, inline: true },
    ...(session.gamesTonight?.length ? [{ name: 'Games Tonight', value: session.gamesTonight.map((game) => `${game.status === 'now_playing' ? '**Now playing**' : game.status === 'up_next' ? '**Up next**' : game.status.replaceAll('_', ' ')} · ${game.title}${game.note ? ` — ${game.note}` : ''}`).join('\n') }] : []),
    ...(session.game.ruleChanged ? [{ name: 'Server rule updated', value: 'This session keeps the player and ownership rule it was created with.' }] : []),
    { name: 'Controls', value: '**Join** claims an open slot. **Leave** removes you. **Open discussion** is the session thread. The host can transfer Host or cancel.' },
  );
  return {
    ...card,
    components: [{
      type: 1,
      components: [
        { type: 2, style: 1, label: 'Join session', custom_id: `lfg:${session.id}:join`, disabled: underway || Boolean(max && confirmed.length >= max) },
        { type: 2, style: 4, label: 'Leave session', custom_id: `lfg:${session.id}:leave` },
        { type: 2, style: 2, label: 'Transfer Host', custom_id: `lfg:${session.id}:transfer` },
        { type: 2, style: 2, label: 'Cancel session', custom_id: `lfg:${session.id}:cancel` },
        ...(discussionThreadId ? [{ type: 2, style: 5, label: 'Open discussion', url: discussionUrl(session.guildId, discussionThreadId) }] : []),
      ],
    }, { type: 1, components: [{ type: 3, custom_id: `live-status:${session.id}`, placeholder: 'Update your Game Night status', min_values: 1, max_values: 1, options: [
      { label: 'Coming', value: 'coming' }, { label: 'Running late', value: 'running_late' }, { label: 'Here now', value: 'here' }, { label: 'Leaving', value: 'leaving' }, { label: 'Joining next game', value: 'joining_next_game' },
    ] }] }, ...(underway ? [{ type: 1, components: [{ type: 2, style: 2, label: 'Complete session', custom_id: `lfg:${session.id}:complete` }] }] : [])],
  };
}

export function completedLfgCard(session) {
  return { embeds: [{ title: `Completed · ${session.game.title}`, description: `This GamePlan session has finished.\n\nOriginally scheduled for ${new Date(session.startsAt).toLocaleString()}.`, footer: { text: 'GamePlan · completed' } }], components: [] };
}

export function cancelledLfgCard(session, { cancellationReason } = {}) {
  const roster = session?.rsvps?.filter((rsvp) => rsvp.response === 'accepted')
    .map((rsvp) => `• ${rsvp.displayName}${rsvp.discordUserId === session.hostDiscordUserId ? ' (Host)' : ''}`)
    .join('\n') || 'No confirmed players';
  const details = [
    session?.hostNote ? `Original note: ${session.hostNote}` : null,
    cancellationReason ? `Reason: ${cancellationReason}` : 'No cancellation reason was provided.',
  ].filter(Boolean).join('\n\n');
  return {
    embeds: [{
      title: `Cancelled · ${session?.game?.title ?? 'GamePlan session'}`,
      color: 0xed4245,
      description: `This GamePlan session was cancelled.${details ? `\n\n${details}` : ''}`,
      fields: [
        ...(session?.startsAt ? [{ name: 'Originally scheduled', value: new Date(session.startsAt).toLocaleString(), inline: true }] : []),
        { name: 'Original roster', value: roster },
      ],
      footer: { text: 'GamePlan · cancelled' },
    }],
    components: [],
  };
}

function rallyRoster(rally) {
  const members = rally.members.filter((member) => member.status === 'in');
  const ready = members.filter((member) => member.steamReady);
  const names = members.map((member) => `${member.displayName}${member.discordUserId === rally.hostDiscordUserId ? ' (Host)' : ''}`).join('\n') || 'Nobody has joined yet';
  return { members, ready, value: `${members.length} attending · ${ready.length} Steam-ready\n${names}`.slice(0, 1024) };
}

export function rallyCard(rally) {
  const roster = rallyRoster(rally);
  const state = {
    open: 'Collecting attendees',
    polling: 'Rank your game choices',
    locked: 'Game locked — session created',
    cancelled: 'Cancelled',
    expired: 'Expired',
  }[rally.state] ?? rally.state;
  const candidateText = rally.state === 'polling'
    ? `${rally.candidates.length} eligible games · roster is frozen`
    : rally.state === 'locked' ? 'The selected game is now an immutable GamePlan session.' : 'Choose attendees first, then open a ranked-choice poll.';
  return {
    embeds: [{
      title: 'GamePlan game vote · Game undecided',
      description: `**${state}**\n${candidateText}`,
      fields: [
        { name: 'Starts', value: new Date(rally.startsAt).toLocaleString(), inline: true },
        { name: 'Roster', value: roster.value },
        ...(rally.voiceChannelId ? [{ name: 'Voice channel', value: `<#${rally.voiceChannelId}>`, inline: true }] : []),
        ...(rally.rosterSnapshot ? [{ name: 'Voting roster', value: `${rally.rosterSnapshot.participantIds.length} attendees locked at ${new Date(rally.rosterSnapshot.capturedAt).toLocaleString()}`, inline: true }] : []),
      ],
      footer: { text: 'GamePlan · attendance is frozen when voting opens' },
    }],
    components: rally.state === 'open' ? [
      { type: 1, components: [
        { type: 2, style: 3, label: 'Join game night', custom_id: `rally:${rally.id}:join` },
        { type: 2, style: 2, label: 'Leave game night', custom_id: `rally:${rally.id}:leave` },
        ...(rally.rosterSource === 'voice' ? [{ type: 2, style: 2, label: 'Refresh voice roster', custom_id: `rally:${rally.id}:refresh` }] : []),
        { type: 2, style: 1, label: 'Start game vote', custom_id: `rally:${rally.id}:open-poll` },
        { type: 2, style: 4, label: 'Cancel game night', custom_id: `rally:${rally.id}:cancel` },
      ] },
    ] : rally.state === 'polling' ? [{ type: 1, components: [
      { type: 2, style: 1, label: 'Rank games', custom_id: `rally:${rally.id}:vote` },
      { type: 2, style: 3, label: 'View result', custom_id: `rally:${rally.id}:result` },
      { type: 2, style: 2, label: 'Choose game', custom_id: `rally:${rally.id}:lock` },
      { type: 2, style: 4, label: 'Cancel game night', custom_id: `rally:${rally.id}:cancel` },
    ] }] : [],
  };
}

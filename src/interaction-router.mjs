import { browserLinkResponse, ephemeral, helpResponse, interactionResponse, onboardingCard, setupResponse } from './discord.mjs';
import { cancelledLfgCard, completedLfgCard, lfgCard, rallyCard, sessionEmbed } from './discord-bot.mjs';
import { isGuildAdmin } from './guild-policy.mjs';
import { createLfgDiscussion, postSessionActivity, updateLfgCard } from './lfg-discussion.mjs';

function commandOption(interaction, name) {
  const flatten = (options = []) => options.flatMap((option) => [option, ...flatten(option.options ?? [])]);
  return flatten(interaction.data?.options).find((option) => option.name === name)?.value;
}
function commandAction(interaction) {
  const first = interaction.data?.options?.[0];
  return first?.options?.[0]?.name ?? first?.name ?? 'plan';
}
function componentValue(interaction, customId) {
  for (const row of interaction.data?.components ?? []) for (const component of row.components ?? []) if (component.custom_id === customId) return component.value ?? '';
  return '';
}
function partyPicker(flowId, members, hostDiscordUserId, selected = []) {
  const people = members.filter((member) => member.discordUserId !== hostDiscordUserId && member.steam?.syncStatus === 'complete').slice(0, 25);
  if (!people.length) return [];
  return [{ type: 1, components: [{ type: 3, custom_id: `party:members:${flowId}`, placeholder: 'Choose people for this session', min_values: 1, max_values: Math.min(15, people.length), options: people.map((member) => ({ label: (member.displayName ?? member.discordUserId).slice(0, 100), value: member.discordUserId, description: member.steam?.syncStatus === 'complete' ? 'Steam ready' : member.steam?.steamId ? 'Steam needs syncing' : 'Steam not linked yet', default: selected.includes(member.discordUserId) })) }] }];
}
function partySummary(party) { return `**People in this session**\n${party.map((member) => `• ${member.displayName ?? member.display_name ?? member.discordUserId ?? member.discord_user_id}`).join('\n')}`; }
const GAME_PAGE_SIZE = 25;
function gameDescription(game) {
  if (game.minPlayers == null && game.maxPlayers == null) return 'Uncurated: confirm player count before inviting.';
  const players = `${game.minPlayers ?? '?'}–${game.maxPlayers ?? '?'} players`;
  return `${players} · ${game.requiresAllOwners ? 'everyone owns' : 'one owner needed'}${game.policyNote ? ` · ${game.policyNote}` : ''}`.slice(0, 100);
}
function gamePage(games, requestedPage = 0) { return Math.max(0, Math.min(Number.isInteger(requestedPage) ? requestedPage : 0, Math.max(0, Math.ceil(games.length / GAME_PAGE_SIZE) - 1))); }
function gamePicker(flowId, games, requestedPage = 0) {
  const selectable = games.filter((game) => game.fitsParty !== false || game.ruleSource === 'unconfigured');
  const page = gamePage(selectable, requestedPage); const pageCount = Math.ceil(selectable.length / GAME_PAGE_SIZE);
  return [{ type: 1, components: [{ type: 3, custom_id: `party:game:${flowId}`, placeholder: 'Choose a shared game', min_values: 1, max_values: 1, options: selectable.slice(page * GAME_PAGE_SIZE, (page + 1) * GAME_PAGE_SIZE).map((game) => ({ label: game.title.slice(0, 100), value: String(game.appId), description: gameDescription(game) })) }] }, { type: 1, components: [{ type: 2, style: 2, custom_id: `party:games:${flowId}:${page - 1}`, label: 'Previous', disabled: page === 0 }, { type: 2, style: 2, custom_id: `party:games-page:${flowId}:${page}`, label: `Page ${page + 1} of ${pageCount}`, disabled: true }, { type: 2, style: 2, custom_id: `party:games:${flowId}:${page + 1}`, label: 'Next', disabled: page === pageCount - 1 }] }, { type: 1, components: [{ type: 2, style: 2, custom_id: `party:change:${flowId}`, label: 'Change people' }] }];
}
function planChooser() {
  return {
    content: '**Plan a session**\nChoose how you want to get tonight moving. You can always adjust the details as you go.',
    components: [
      { type: 1, components: [
        { type: 2, style: 1, custom_id: 'plan:pick-game', label: 'Pick a game', emoji: { name: '🎮' } },
        { type: 2, style: 2, custom_id: 'plan:decide-together', label: 'Decide together', emoji: { name: '🗳️' } },
        { type: 2, style: 2, custom_id: 'plan:voice-now', label: 'Use my voice channel', emoji: { name: '🎙️' } },
      ] },
    ],
  };
}
function rulePicker(rules) { return rules.length ? [{ type: 1, components: [{ type: 3, custom_id: 'rules:edit', placeholder: 'Choose a game setting to edit', min_values: 1, max_values: 1, options: rules.slice(0, 25).map((rule) => ({ label: (rule.game_name ?? `Steam app ${rule.steam_app_id}`).slice(0, 100), value: String(rule.steam_app_id), description: `${rule.min_players}–${rule.max_players} players · ${rule.requires_all_owners ? 'everyone owns' : 'one owner'}` })) }] }] : []; }
function gameSettingsPanel(rules, browserUrl) {
  const summary = rules.length
    ? `**Game settings**\n${rules.slice(0, 25).map((rule) => `• ${rule.game_name ?? `Steam app ${rule.steam_app_id}`}: ${rule.min_players}–${rule.max_players} players · ${rule.requires_all_owners ? 'everyone owns' : 'one owner'}${rule.changed_by ? ` · last changed by ${rule.changed_by}` : ''}`).join('\n')}\n\nChoose a saved setting for a quick Discord edit, or open the full editor to add settings for games your server has discovered.`
    : '**Game settings**\nNo server game settings yet. Open the full editor to add player counts and ownership requirements for games found across synced players.';
  return ephemeral(summary, [...rulePicker(rules), { type: 1, components: [{ type: 2, style: 5, label: 'Open game settings', url: browserUrl }] }]);
}
function editRuleModal(rule) { return { type: 9, data: { custom_id: `rules:save:${rule.steam_app_id}`, title: `Edit · ${rule.game_name ?? `Steam ${rule.steam_app_id}`}`.slice(0, 45), components: [
  { type: 1, components: [{ type: 4, custom_id: 'min-players', label: 'Minimum players', style: 1, value: String(rule.min_players), required: true }] },
  { type: 1, components: [{ type: 4, custom_id: 'max-players', label: 'Maximum players', style: 1, value: String(rule.max_players), required: true }] },
  { type: 1, components: [{ type: 4, custom_id: 'ownership', label: 'Ownership: all or one', style: 1, value: rule.requires_all_owners ? 'all' : 'one', required: true }] },
] } }; }
function notificationPanel(settings) {
  const deliveryOptions = (selected) => [['off', 'Off'], ['dm', 'DM'], ['thread', 'Session thread'], ['both', 'DM + thread']].map(([value, label]) => ({ label, value, default: selected === value }));
  const leads = [15, 60, 1440];
  return {
    content: `**GamePlan notifications**\nSession reminders: **${settings.reminderDelivery}** · ${settings.reminderLeadMinutes.map((lead) => lead >= 60 ? `${lead / 60}h` : `${lead}m`).join(', ') || 'no reminder times'}\nGame alerts for sessions you own: **${settings.lfgAlertDelivery}**\nGames Tonight changes: **${settings.gameNightChangeDelivery}**\nTimezone: **${settings.timezone}** · Quiet hours: **${settings.quietStart && settings.quietEnd ? `${settings.quietStart}–${settings.quietEnd}` : 'off'}**\nMuted games: **${settings.mutedGames.length}**\n\nGames Tonight changes default to DM. Choose Off to opt out. DMs fall back to the session thread when possible.`,
    components: [
      { type: 1, components: [{ type: 3, custom_id: 'notify:reminder-delivery', placeholder: 'Session reminder delivery', min_values: 1, max_values: 1, options: deliveryOptions(settings.reminderDelivery) }] },
      { type: 1, components: [{ type: 3, custom_id: 'notify:reminder-leads', placeholder: 'Reminder times', min_values: 0, max_values: 3, options: leads.map((lead) => ({ label: lead >= 60 ? `${lead / 60} hour${lead === 60 ? '' : 's'} before` : `${lead} minutes before`, value: String(lead), default: settings.reminderLeadMinutes.includes(lead) })) }] },
      { type: 1, components: [{ type: 3, custom_id: 'notify:lfg-delivery', placeholder: 'Game alerts for sessions you own', min_values: 1, max_values: 1, options: deliveryOptions(settings.lfgAlertDelivery) }] },
      { type: 1, components: [{ type: 3, custom_id: 'notify:game-night-change-delivery', placeholder: 'Games Tonight changes', min_values: 1, max_values: 1, options: deliveryOptions(settings.gameNightChangeDelivery) }] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: 'notify:quiet', label: 'Timezone and quiet hours' }, { type: 2, style: 2, custom_id: 'notify:mutes', label: 'Muted games' }] },
    ],
  };
}
function feedbackNotificationPanel(settings) {
  const options = (enabled) => [
    { label: 'On', value: 'on', default: enabled },
    { label: 'Off', value: 'off', default: !enabled },
  ];
  return {
    content: `**Feedback notifications**\nUpdates to feedback you created: **${settings.ownerUpdatesEnabled ? 'on' : 'off'}**\nReplies to feedback you participate in: **${settings.participantUpdatesEnabled ? 'on' : 'off'}**\n\nThese preferences apply to this GamePlan deployment and default to on.`,
    components: [
      { type: 1, components: [{ type: 3, custom_id: 'feedback-notify:owner', placeholder: 'Updates to my feedback', min_values: 1, max_values: 1, options: options(settings.ownerUpdatesEnabled) }] },
      { type: 1, components: [{ type: 3, custom_id: 'feedback-notify:participant', placeholder: 'Replies to feedback I participate in', min_values: 1, max_values: 1, options: options(settings.participantUpdatesEnabled) }] },
    ],
  };
}
function rallyDatePicker(flowId, timezone) { return [{ type: 1, components: [{ type: 3, custom_id: `rally:date:${flowId}`, placeholder: `Choose a date (${timezone})`, min_values: 1, max_values: 1, options: dateOptions(timezone) }] }]; }
function rallyTimePicker(flowId, date, timezone) { return [{ type: 1, components: [{ type: 3, custom_id: `rally:time:${flowId}`, placeholder: `Choose a time (${timezone})`, min_values: 1, max_values: 1, options: date === dateOptions(timezone)[0].value ? londonTimeOptions(new Date(), timezone) : Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, '0')}:00`, value: `${String(hour).padStart(2, '0')}:00` })) }] }]; }
function rallyRosterPicker(flowId) { return [
  { type: 1, components: [{ type: 8, custom_id: `rally:voice:${flowId}`, placeholder: 'Use a voice channel roster', channel_types: [2], min_values: 1, max_values: 1 }] },
  { type: 1, components: [{ type: 2, style: 2, custom_id: `rally:manual:${flowId}`, label: 'Use manual attendance instead' }] },
]; }
function votePanel(flow, rally) {
  const choices = flow.payload.choices ?? [];
  const available = rally.candidates.filter((candidate) => !choices.includes(candidate.appId));
  const pageCount = Math.max(1, Math.ceil(available.length / GAME_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(flow.payload.page) || 0, pageCount - 1));
  const rank = choices.length + 1;
  return {
    content: `**Rank your GamePlan choices**\n${choices.length ? `Current ranking: ${choices.map((appId, index) => `${index + 1}. ${rally.candidates.find((candidate) => candidate.appId === appId)?.title ?? appId}`).join(' · ')}` : 'Choose your first choice.'}\n\nPick choice ${rank} (optional after your first), then submit when you are happy.`,
    components: available.length ? [
      { type: 1, components: [{ type: 3, custom_id: `rally-vote:pick:${flow.id}:${page}`, placeholder: `Choose #${rank}`, min_values: 1, max_values: 1, options: available.slice(page * GAME_PAGE_SIZE, (page + 1) * GAME_PAGE_SIZE).map((candidate) => ({ label: candidate.title.slice(0, 100), value: String(candidate.appId), description: `${candidate.potentialParticipants} can play · ${candidate.minPlayers}-${candidate.maxPlayers} players`.slice(0, 100) })) }] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: `rally-vote:page:${flow.id}:${page - 1}`, label: 'Previous', disabled: page === 0 }, { type: 2, style: 2, custom_id: `rally-vote:page:${flow.id}:${page + 1}`, label: 'Next', disabled: page === pageCount - 1 }, { type: 2, style: 3, custom_id: `rally-vote:submit:${flow.id}`, label: choices.length ? 'Submit ranking' : 'Skip voting' }] },
    ] : [{ type: 1, components: [{ type: 2, style: 3, custom_id: `rally-vote:submit:${flow.id}`, label: 'Submit ranking' }] }],
  };
}
function lockPanel(flow, rally) {
  const pageCount = Math.max(1, Math.ceil(rally.candidates.length / GAME_PAGE_SIZE));
  const page = Math.max(0, Math.min(Number(flow.payload.page) || 0, pageCount - 1));
  return { content: '**Choose the game**\nThe game-vote host makes the final selection. This creates an immutable GamePlan session using the frozen roster and the game’s current rule snapshot.', components: [
    { type: 1, components: [{ type: 3, custom_id: `rally-lock:pick:${flow.id}:${page}`, placeholder: 'Choose the game to lock', min_values: 1, max_values: 1, options: rally.candidates.slice(page * GAME_PAGE_SIZE, (page + 1) * GAME_PAGE_SIZE).map((candidate) => ({ label: candidate.title.slice(0, 100), value: String(candidate.appId), description: `${candidate.potentialParticipants} can play · ${candidate.minPlayers}-${candidate.maxPlayers} players`.slice(0, 100) })) }] },
    { type: 1, components: [{ type: 2, style: 2, custom_id: `rally-lock:page:${flow.id}:${page - 1}`, label: 'Previous', disabled: page === 0 }, { type: 2, style: 2, custom_id: `rally-lock:page:${flow.id}:${page + 1}`, label: 'Next', disabled: page === pageCount - 1 }] },
  ] };
}
function updatePanel(panel) { const { flags, ...data } = panel.data; return { type: 7, data }; }
function dateOptions(timezone = 'Europe/London', now = new Date()) { return Array.from({ length: 14 }, (_, offset) => { const date = new Date(now); date.setUTCDate(date.getUTCDate() + offset); const value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); const label = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : new Intl.DateTimeFormat('en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(date); return { label, value }; }); }
function datePicker(flowId, timezone) { return [{ type: 1, components: [{ type: 3, custom_id: `party:date:${flowId}`, placeholder: `Choose a date (${timezone})`, min_values: 1, max_values: 1, options: dateOptions(timezone) }] }]; }
export function londonTimeOptions(now = new Date(), timezone = 'Europe/London') {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour').value);
  const minute = Number(parts.find((part) => part.type === 'minute').value);
  const firstMinute = (Math.floor((hour * 60 + minute) / 30) + 1) * 30;
  const count = Math.min(16, Math.max(0, (24 * 60 - firstMinute) / 30));
  return Array.from({ length: count }, (_, index) => {
    const total = firstMinute + index * 30;
    return { label: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`, value: `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}` };
  });
}
function timePicker(flowId, date, timezone = 'Europe/London') { const today = dateOptions(timezone)[0].value; const options = date === today ? londonTimeOptions(new Date(), timezone) : Array.from({ length: 24 }, (_, hour) => ({ label: `${String(hour).padStart(2, '0')}:00`, value: `${String(hour).padStart(2, '0')}:00` })); return [{ type: 1, components: [{ type: 3, custom_id: `party:time:${flowId}`, placeholder: `Choose a time (${timezone})`, min_values: 1, max_values: 1, options }] }]; }
function zonedStartAt(date, time, timezone = 'Europe/London') { const probe = new Date(`${date}T12:00:00Z`); const zone = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeZoneName: 'shortOffset' }).formatToParts(probe).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'; const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone); const offsetMinutes = match ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) : 0; return new Date(Date.parse(`${date}T${time}:00Z`) - offsetMinutes * 60_000).toISOString(); }
function planModal(flowId, gameTitle, date, time) { return { type: 9, data: { custom_id: `party:create:${flowId}`, title: `Plan ${gameTitle}`.slice(0, 45), components: [{ type: 1, components: [{ type: 4, custom_id: 'host-note', label: `Note for ${date} ${time} UK time (optional)`.slice(0, 45), style: 2, max_length: 500, required: false, placeholder: 'Voice channel, DLC, or anything useful' }] }] } }; }
function gameRulesModal(flowId, game, partySize) { return { type: 9, data: { custom_id: `party:rules:${flowId}`, title: `Set rules · ${game.title}`.slice(0, 45), components: [
  { type: 1, components: [{ type: 4, custom_id: 'min-players', label: 'Minimum players', style: 1, value: '1', max_length: 3, required: true }] },
  { type: 1, components: [{ type: 4, custom_id: 'max-players', label: 'Maximum players', style: 1, value: String(partySize), max_length: 3, required: true }] },
] } }; }
function ownershipPicker(flowId) { return [{ type: 1, components: [{ type: 3, custom_id: `party:ownership:${flowId}`, placeholder: 'Who needs to own this game?', min_values: 1, max_values: 1, options: [
  { label: 'Everyone in this session', value: 'all', description: 'Standard co-op: every participant owns a copy.' },
  { label: 'At least one player', value: 'one', description: 'For host-owned or pass-the-controller games.' },
] }] }]; }
function cancelModal(sessionId) { return { type: 9, data: { custom_id: `lfg:${sessionId}:cancel-submit`, title: 'Cancel GamePlan session', components: [{ type: 1, components: [{ type: 4, custom_id: 'cancellation-reason', label: 'Reason (optional)', style: 2, max_length: 500, required: false, placeholder: 'For example: not enough players tonight' }] }] } }; }
function formatSessions(sessions) { return sessions.length ? `**Your sessions**\n\n${sessions.slice(0, 10).map((session) => `**${session.game.title}**\n${new Date(session.startsAt).toLocaleString()} · ${session.rsvps.map((rsvp) => `${rsvp.displayName}: ${rsvp.response}`).join(', ')}`).join('\n\n')}${sessions.length > 10 ? `\n\nShowing 10 of ${sessions.length}.` : ''}` : 'You have no upcoming GamePlan sessions.'; }
function regularGameNightPanel(upcoming, gameNights) {
  const active = gameNights.filter((gameNight) => gameNight.active);
  const summary = active.length ? active.map((gameNight) => `• ${gameNight.cadence === 'fortnightly' ? 'Every two weeks' : 'Every week'}${gameNight.nextStartsAt ? ` · next ${new Date(gameNight.nextStartsAt).toLocaleString()}` : ''}`).join('\n') : 'No regular Game Nights yet.';
  const options = upcoming.flatMap((session) => [
    { label: `${session.game.title} · every week`.slice(0, 100), value: `${session.id}|weekly`, description: new Date(session.startsAt).toLocaleString().slice(0, 100) },
    { label: `${session.game.title} · every two weeks`.slice(0, 100), value: `${session.id}|fortnightly`, description: new Date(session.startsAt).toLocaleString().slice(0, 100) },
  ]).slice(0, 25);
  return { content: `**Regular Game Nights**\n${summary}\n\nChoose one of your upcoming Game Nights and how often it repeats. Each later Game Night gets a fresh RSVP list.`, components: options.length ? [{ type: 1, components: [{ type: 3, custom_id: 'regular:create', placeholder: 'Make an upcoming Game Night regular', min_values: 1, max_values: 1, options }] }] : [] };
}
function gameTonightStatus(status) { return status === 'now_playing' ? 'Now playing' : status === 'up_next' ? 'Up next' : status.replaceAll('_', ' '); }
function gamesTonightSummary(games) { return games.length ? games.map((game) => `${gameTonightStatus(game.status)} · ${game.title}${game.note ? ` — ${game.note}` : ''}`).join('\n') : 'No Games Tonight yet.'; }
function gamesTonightPanel(session, games) {
  return {
    content: `**Games Tonight · ${session.game.title}**\n${gamesTonightSummary(games)}\n\nChoose a game to change its status, order, note, or expected players.`,
    components: [
      { type: 1, components: [{ type: 2, style: 3, custom_id: `tonight:add:${session.id}`, label: 'Add game' }, { type: 2, style: 2, custom_id: `tonight:replan:${session.id}`, label: 'Replan for live roster' }, { type: 2, style: 2, custom_id: 'tonight:back', label: 'Back' }] },
      ...(games.length ? [{ type: 1, components: [{ type: 3, custom_id: `tonight:game:${session.id}`, placeholder: 'Choose a game to manage', min_values: 1, max_values: 1, options: games.slice(0, 25).map((game) => ({ label: `${gameTonightStatus(game.status)} · ${game.title}`.slice(0, 100), value: game.id, description: (game.note ?? 'Change this game').slice(0, 100) })) }] }] : []),
    ],
  };
}
function replanPanel(session, options) {
  const combinations = options.audiences.flatMap((audience) => audience.alternatives.flatMap((alternative) => options.replaceableGames.map((game) => ({
    label: `${audience.label} · ${gameTonightStatus(game.status)} → ${alternative.title}`.slice(0, 100),
    value: `${audience.key}|${game.id}|${alternative.appId}`,
    description: `${alternative.minPlayers}–${alternative.maxPlayers} players`.slice(0, 100),
  })))).slice(0, 25);
  const explanation = options.audiences.map((audience) => `**${audience.label}**: ${audience.people.map((person) => person.displayName).join(', ') || 'only you'}${audience.message ? `\n${audience.message}` : ''}`).join('\n\n');
  return {
    content: `**Replan Games Tonight · ${session.game.title}**\n${explanation}\n\nGamePlan will not change anything until you choose a replacement below.`,
    components: [
      ...(combinations.length ? [{ type: 1, components: [{ type: 3, custom_id: `tonight:replan-apply:${session.id}`, placeholder: 'Choose a host-approved replacement', min_values: 1, max_values: 1, options: combinations }] }] : []),
      { type: 1, components: [{ type: 2, style: 2, custom_id: `tonight:manage:${session.id}`, label: 'Back to Games Tonight' }] },
    ],
  };
}
function gameTonightItemPanel(session, game, games) {
  const compatibility = game.compatibility?.fitsParty === true ? `${game.compatibility.playerCount} expected · ready to play.` : game.compatibility?.playerCount ? `${game.compatibility.playerCount} expected · compatibility needs attention.` : 'Choose expected players to check compatibility.';
  return {
    content: `**${game.title}**\n${gameTonightStatus(game.status)}${game.note ? ` · ${game.note}` : ''}\n${compatibility}`,
    components: [
      { type: 1, components: [{ type: 3, custom_id: `tonight:status:${session.id}:${game.id}`, placeholder: 'Change status', min_values: 1, max_values: 1, options: ['up_next','now_playing','completed','skipped','replaced'].map((status) => ({ label: gameTonightStatus(status), value: status, default: status === game.status })) }] },
      { type: 1, components: [
        { type: 2, style: 2, custom_id: `tonight:earlier:${session.id}:${game.id}`, label: 'Earlier', disabled: game.position === 0 },
        { type: 2, style: 2, custom_id: `tonight:later:${session.id}:${game.id}`, label: 'Later', disabled: game.position === games.length - 1 },
        { type: 2, style: 2, custom_id: `tonight:note:${session.id}:${game.id}`, label: 'Edit note' },
        { type: 2, style: 2, custom_id: `tonight:players:${session.id}:${game.id}`, label: 'Expected players' },
        { type: 2, style: 4, custom_id: `tonight:remove:${session.id}:${game.id}`, label: 'Remove' },
      ] },
      { type: 1, components: [{ type: 2, style: 2, custom_id: `tonight:manage:${session.id}`, label: 'Back to Games Tonight' }] },
    ],
  };
}
function gameTonightAddModal(sessionId) { return { type: 9, data: { custom_id: `tonight:add-submit:${sessionId}`, title: 'Add a game tonight', components: [
  { type: 1, components: [{ type: 4, custom_id: 'app-id', label: 'Steam app ID', style: 1, required: true, max_length: 12, placeholder: 'For example: 548430' }] },
  { type: 1, components: [{ type: 4, custom_id: 'title', label: 'Game title', style: 1, required: true, max_length: 500 }] },
  { type: 1, components: [{ type: 4, custom_id: 'note', label: 'Why this game? (optional)', style: 2, required: false, max_length: 500, placeholder: 'For example: while we wait for Mike' }] },
] } }; }
function gameTonightNoteModal(sessionId, game) { return { type: 9, data: { custom_id: `tonight:note-submit:${sessionId}:${game.id}`, title: `Note · ${game.title}`.slice(0, 45), components: [{ type: 1, components: [{ type: 4, custom_id: 'note', label: 'What should people know?', style: 2, required: false, max_length: 500, value: game.note ?? '', placeholder: 'For example: while we wait for Mike' }] }] } }; }
function gameTonightPlayersPanel(session, game) {
  return { content: `**Expected players · ${game.title}**\nChoose who this game is for. GamePlan checks this group’s Steam compatibility.`, components: [
    { type: 1, components: [{ type: 3, custom_id: `tonight:save-players:${session.id}:${game.id}`, placeholder: 'Choose expected players', min_values: 1, max_values: Math.min(25, session.rsvps.length), options: session.rsvps.slice(0, 25).map((rsvp) => ({ label: rsvp.displayName.slice(0, 100), value: rsvp.discordUserId, default: game.playerIds.includes(rsvp.discordUserId) })) }] },
    { type: 1, components: [{ type: 2, style: 2, custom_id: `tonight:game:${session.id}:${game.id}`, label: 'Back' }] },
  ] };
}

export async function handleDiscordInteraction({ interaction, actor, identity, guildPolicy, bot, planner, rallies = null, database, flows, notifications = null, feedbackNotifications = null, syncSteamLibrary, sendInvites, publishSessionToFeed, issueBrowserUrl, feedbackUrl = null }) {
  const setupPanel = async ({ update = false } = {}) => {
    const policy = await guildPolicy.get(actor.guildId);
    const panel = setupResponse(policy);
    return update ? updatePanel(panel) : panel;
  };
  const configuredGuild = async () => !actor.guildId || await guildPolicy.isInstalled(actor.guildId);
  const botCanPostInChannel = async (channelId) => {
    if (!actor.guildId || !channelId) return false;
    try {
      return (await bot.sendableTextChannels(actor.guildId)).some((channel) => channel.id === channelId);
    } catch {
      return false;
    }
  };
  const partyPickerFor = async (flowId, selected = []) => partyPicker(flowId, await planner.getPlanner(actor.guildId, actor.discordUserId), actor.discordUserId, selected);
  const publishRally = async (rally) => {
    if (!await botCanPostInChannel(interaction.channel_id)) throw new Error('GamePlan cannot post a game vote in this channel. Grant it View Channel and Send Messages, then try again.');
    const message = await bot.send(interaction.channel_id, rallyCard(rally));
    await database.query(`INSERT INTO rally_posts (rally_id,guild_id,channel_id,message_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (rally_id) DO UPDATE SET channel_id=EXCLUDED.channel_id,message_id=EXCLUDED.message_id,published_at=now()`, [rally.id, rally.guildId, interaction.channel_id, message.id]);
    return message;
  };

  if (interaction.type === 2 && interaction.data?.name === 'gameplan') {
    const action = commandAction(interaction);
    if (action === 'help') return helpResponse();
    if (action === 'feedback') {
      if (!feedbackUrl) return ephemeral('Feedback is not configured for this GamePlan deployment.');
      const browserUrl = await issueBrowserUrl(actor, { continueTo: feedbackUrl });
      return ephemeral('Share feedback or request a feature.', [{ type: 1, components: [{ type: 2, style: 5, label: 'Share feedback', url: browserUrl }] }]);
    }
    if (action === 'feedback-notifications') {
      if (!feedbackUrl || !feedbackNotifications) return ephemeral('Feedback notifications are not configured for this GamePlan deployment.');
      await identity.recordDiscordUser(actor);
      const panel = feedbackNotificationPanel(await feedbackNotifications.getSettings(actor.discordUserId));
      return ephemeral(panel.content, panel.components);
    }
    if (action === 'setup' || action === 'server') {
      if (!actor.guildId || !isGuildAdmin(actor.guildPermissions)) return ephemeral('GamePlan setup requires Manage Server or Administrator permission.');
      await identity.recordDiscordUser({ ...actor, establishGuild: true });
      return setupPanel();
    }
    if (action === 'me' || action === 'sync') {
      await identity.recordDiscordUser(actor);
      const profile = await identity.getProfile(actor.discordUserId);
      if (action === 'me') {
        const settings = actor.guildId && notifications ? await notifications.getSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId }) : null;
        const status = !profile?.steam_id ? 'Steam is not linked yet.' : profile.last_sync_status === 'complete' ? `Steam is linked and ${profile.last_sync_game_count ?? 0} games are synced.` : `Steam is linked, but sync status is **${profile.last_sync_status}**.`;
        return browserLinkResponse(`${status}${settings ? `\nNotifications: **${settings.reminderDelivery}** reminders, **${settings.lfgAlertDelivery}** game alerts, **${settings.mutedGames.length}** muted games.` : ''}\n\nUse the private web view to link Steam or edit your notification settings.`, await issueBrowserUrl(actor));
      }
      if (!profile?.steam_id) return browserLinkResponse('Link Steam first, then choose **Link Steam** in your private GamePlan view.', await issueBrowserUrl(actor));
      try {
        const result = await syncSteamLibrary(actor.discordUserId, profile);
        return ephemeral(result.status === 'complete' ? `Steam library synced: **${result.gameCount} games** are ready for planning.` : 'Steam is linked, but its library is private or unavailable. Make your Steam profile and game details public, then run **/gameplan sync** again.');
      } catch (error) { return ephemeral(`Steam sync failed: ${error.message}`); }
    }
    if (!await configuredGuild()) return ephemeral('GamePlan has not been set up in this server yet. Ask an admin to run **/gameplan server**.');
    if (action === 'invite' && !await botCanPostInChannel(interaction.channel_id)) return ephemeral('GamePlan cannot post in this channel. Ask an admin to grant the bot View Channel and Send Messages permission.');
    await identity.recordDiscordUser(actor);
    if (action === 'invite') return onboardingCard();
    if (action === 'group') return browserLinkResponse('Open the Group view to compare your server’s Steam ownership.', await issueBrowserUrl(actor));
    if (action === 'games') {
      const games = await planner.listGuildGameSettings(actor.guildId);
      const configured = games.filter((game) => game.status === 'server-setting').length;
      const unconfigured = games.filter((game) => game.status === 'needs-review').length;
      return browserLinkResponse(`**Games**\n${configured} configured · ${unconfigured} need review. Open the Games view to filter and edit the full library.`, await issueBrowserUrl(actor));
    }
    if (action === 'library') {
      const profile = await identity.getProfile(actor.discordUserId);
      if (!profile?.steam_id) return browserLinkResponse('Link Steam first, then open **/gameplan me** to view it here.', await issueBrowserUrl(actor));
      const requestedPage = Number(commandOption(interaction, 'page') ?? 1);
      const library = await identity.getOwnedGames(actor.discordUserId, { page: Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1 });
      const header = profile.last_sync_status === 'complete' ? `**Your Steam library** · ${library.total} games` : `**Your Steam library** · sync status: ${profile.last_sync_status}`;
      const listing = library.games.length ? library.games.map((game) => `• ${game.name}`).join('\n') : 'No visible games on this page. Run **/gameplan sync** after making Steam game details public.';
      return ephemeral(`${header}\nPage ${library.page}\n\n${listing}${library.total > library.games.length * library.page ? '\n\nOpen **/gameplan me** to see the rest of your library.' : ''}`);
    }
    if (action === 'start' || action === 'plan') return ephemeral(planChooser().content, planChooser().components);
    if (action === 'notifications') {
      if (!actor.guildId || !notifications) return ephemeral('Run **/gameplan notifications** in a server to configure your private notification preferences.');
      const panel = notificationPanel(await notifications.getSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId }));
      return ephemeral(panel.content, panel.components);
    }
    if (action === 'game-settings') {
      if (!actor.guildId) return ephemeral('Run **/gameplan games** in a server.');
      const rules = await planner.listGuildGameRules(actor.guildId);
      return gameSettingsPanel(rules, await issueBrowserUrl(actor));
    }
    if (action === 'sessions') {
      if (!actor.guildId) return ephemeral('Run **/gameplan sessions** in a server to view that group’s plans.');
      return ephemeral(formatSessions(await planner.listSessions(actor.guildId, actor.discordUserId)));
    }
    if (action === 'tonight') {
      if (!actor.guildId) return ephemeral('Run **/gameplan tonight** in a server to view Games Tonight.');
      const sessions = await planner.listSessions(actor.guildId, actor.discordUserId);
      const entries = await Promise.all(sessions.slice(0, 5).map(async (session) => {
        const games = await planner.listGamesTonight(session.id, actor.discordUserId);
        return { session, games: games ?? [] };
      }));
      const lines = entries.map(({ session, games }) => `**${session.game.title}**\n${games.map((game) => `${game.status === 'now_playing' ? 'Now playing' : game.status === 'up_next' ? 'Up next' : game.status.replaceAll('_', ' ')} · ${game.title}${game.note ? ` — ${game.note}` : ''}`).join('\n') || 'No Games Tonight yet.'}`).join('\n\n');
      const hosted = entries.filter(({ session }) => session.hostDiscordUserId === actor.discordUserId);
      const components = hosted.length ? [{ type: 1, components: [{ type: 3, custom_id: 'tonight:open', placeholder: 'Manage Games Tonight', min_values: 1, max_values: 1, options: hosted.slice(0, 25).map(({ session }) => ({ label: `${session.game.title} · ${new Date(session.startsAt).toLocaleString()}`.slice(0, 100), value: session.id })) }] }] : [];
      return ephemeral(lines || 'You have no upcoming Game Nights.', components);
    }
    if (action === 'regular') {
      if (!actor.guildId) return ephemeral('Run **/gameplan regular** in a server to make a regular Game Night.');
      const panel = regularGameNightPanel(await planner.listHostedUpcomingSessions(actor.guildId, actor.discordUserId), await planner.listRegularGameNights(actor.guildId, actor.discordUserId));
      return ephemeral(panel.content, panel.components);
    }
    if (action === 'status') {
      const profile = await identity.getProfile(actor.discordUserId);
      const status = !profile?.steam_id ? 'Steam is not linked yet. Use **Open GamePlan** to begin.' : profile.last_sync_status === 'complete' ? profile.last_sync_game_count === 0 ? 'Steam is linked and visible, but this library is empty.' : `Steam is linked and ${profile.last_sync_game_count ?? 'your'} games are ready for shared-game planning.` : `Steam is linked, but sync status is **${profile.last_sync_status}**. Check Steam library visibility, then sync again.`;
      return browserLinkResponse(status, await issueBrowserUrl(actor));
    }
    return interactionResponse(interaction, { browserUrl: await issueBrowserUrl(actor) });
  }

  const parts = interaction.data?.custom_id?.split(':') ?? [];
  const tonightSessionId = /^[0-9a-f-]{36}$/.test(parts[2] ?? '') ? parts[2] : null;
  const tonightGameId = /^[0-9a-f-]{36}$/.test(parts[3] ?? '') ? parts[3] : null;
  const tonightSession = async (sessionId) => {
    const session = await planner.getSession(sessionId, actor.discordUserId);
    if (!session) throw new Error('That Game Night is not available.');
    return session;
  };
  const tonightGames = async (sessionId) => await planner.listGamesTonight(sessionId, actor.discordUserId) ?? [];
  const refreshTonightCard = async (sessionId) => {
    const session = await tonightSession(sessionId);
    const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [sessionId]);
    await updateLfgCard({ session, post, bot });
    return session;
  };
  const announceTonightChange = async (sessionId, content, changeKey) => {
    const session = await refreshTonightCard(sessionId);
    const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [sessionId]);
    if (post.rowCount) await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content, notifyDiscordUserIds: [] });
    await notifications?.queueGameNightChange?.({ session, content, changeKey });
    return session;
  };
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'open' && actor.guildId) {
    try { const session = await tonightSession(interaction.data.values?.[0]); const games = await tonightGames(session.id); return { type: 7, data: gamesTonightPanel(session, games) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'back') {
    return ephemeral('Run **/gameplan tonight** to view or manage Games Tonight.');
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'manage' && tonightSessionId) {
    try { const session = await tonightSession(tonightSessionId); return { type: 7, data: gamesTonightPanel(session, await tonightGames(session.id)) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'replan' && tonightSessionId) {
    try { const session = await tonightSession(tonightSessionId); return { type: 7, data: replanPanel(session, await planner.replanOptions({ sessionId: tonightSessionId, hostDiscordUserId: actor.discordUserId })) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'replan-apply' && tonightSessionId) {
    try {
      const [audience, gameId, appId] = (interaction.data.values?.[0] ?? '').split('|');
      const result = await planner.replaceGameTonight({ sessionId: tonightSessionId, gameId, hostDiscordUserId: actor.discordUserId, audience, appId: Number(appId) });
      await announceTonightChange(tonightSessionId, `Games Tonight changed: **${result.replacement.title}** replaces **${result.replaced.title}** for ${result.audience.label.toLowerCase()}.`, `replacement:${result.replaced.id}:${result.replacement.appId}:${result.audience.key}`);
      return { type: 7, data: gamesTonightPanel(await tonightSession(tonightSessionId), result.games) };
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'game' && tonightSessionId) {
    try { const games = await tonightGames(tonightSessionId); const gameId = tonightGameId ?? interaction.data.values?.[0]; const game = games.find((entry) => entry.id === gameId); if (!game) throw new Error('That Game Tonight item is not available.'); return { type: 7, data: gameTonightItemPanel(await tonightSession(tonightSessionId), game, games) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'add' && tonightSessionId) return gameTonightAddModal(tonightSessionId);
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'note' && tonightSessionId && tonightGameId) {
    try { const game = (await tonightGames(tonightSessionId)).find((entry) => entry.id === tonightGameId); if (!game) throw new Error('That Game Tonight item is not available.'); return gameTonightNoteModal(tonightSessionId, game); } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'players' && tonightSessionId && tonightGameId) {
    try { const games = await tonightGames(tonightSessionId); const game = games.find((entry) => entry.id === tonightGameId); if (!game) throw new Error('That Game Tonight item is not available.'); return { type: 7, data: gameTonightPlayersPanel(await tonightSession(tonightSessionId), game) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'status' && tonightSessionId && tonightGameId) {
    try { const games = await planner.updateGameTonight({ sessionId: tonightSessionId, gameId: tonightGameId, hostDiscordUserId: actor.discordUserId, status: interaction.data.values?.[0], note: (await tonightGames(tonightSessionId)).find((entry) => entry.id === tonightGameId)?.note ?? '' }); const game = games.find((entry) => entry.id === tonightGameId); const nowPlaying = games.find((entry) => entry.status === 'now_playing'); const session = await announceTonightChange(tonightSessionId, `Games Tonight changed: **${game.title}** is ${game.status.replaceAll('_', ' ')}.${nowPlaying && nowPlaying.id !== game.id ? ` Now playing: **${nowPlaying.title}**.` : ''}`, `status:${game.id}:${game.status}`); return { type: 7, data: gameTonightItemPanel(session, game, games) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && ['earlier','later','remove'].includes(parts[1]) && tonightSessionId && tonightGameId) {
    try {
      const before = await tonightGames(tonightSessionId); const game = before.find((entry) => entry.id === tonightGameId); if (!game) throw new Error('That Game Tonight item is not available.');
      const games = parts[1] === 'remove' ? await planner.removeGameTonight({ sessionId: tonightSessionId, gameId: tonightGameId, hostDiscordUserId: actor.discordUserId }) : await planner.reorderGameTonight({ sessionId: tonightSessionId, gameId: tonightGameId, hostDiscordUserId: actor.discordUserId, position: game.position + (parts[1] === 'earlier' ? -1 : 1) });
      return { type: 7, data: gamesTonightPanel(await refreshTonightCard(tonightSessionId), games) };
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'tonight' && parts[1] === 'save-players' && tonightSessionId && tonightGameId) {
    try { const games = await planner.setGameTonightPlayers({ sessionId: tonightSessionId, gameId: tonightGameId, hostDiscordUserId: actor.discordUserId, playerIds: interaction.data.values ?? [] }); const game = games.find((entry) => entry.id === tonightGameId); return { type: 7, data: gameTonightItemPanel(await refreshTonightCard(tonightSessionId), game, games) }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 5 && parts[0] === 'tonight' && parts[1] === 'add-submit' && /^[0-9a-f-]{36}$/.test(parts[2] ?? '')) {
    try { const games = await planner.addGameTonight({ sessionId: parts[2], hostDiscordUserId: actor.discordUserId, appId: Number(componentValue(interaction, 'app-id')), title: componentValue(interaction, 'title'), note: componentValue(interaction, 'note') }); return { type: 4, data: { flags: 64, ...gamesTonightPanel(await refreshTonightCard(parts[2]), games) } }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 5 && parts[0] === 'tonight' && parts[1] === 'note-submit' && /^[0-9a-f-]{36}$/.test(parts[2] ?? '') && /^[0-9a-f-]{36}$/.test(parts[3] ?? '')) {
    try { const before = await tonightGames(parts[2]); const game = before.find((entry) => entry.id === parts[3]); if (!game) throw new Error('That Game Tonight item is not available.'); const games = await planner.updateGameTonight({ sessionId: parts[2], gameId: parts[3], hostDiscordUserId: actor.discordUserId, status: game.status, note: componentValue(interaction, 'note') }); return { type: 4, data: { flags: 64, ...gameTonightItemPanel(await refreshTonightCard(parts[2]), games.find((entry) => entry.id === parts[3]), games) } }; } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'live-status' && /^[0-9a-f-]{36}$/.test(parts[1])) {
    try {
      const session = await planner.updateLiveStatus({ id: parts[1], actorDiscordUserId: actor.discordUserId, status: interaction.data.values?.[0] });
      const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [parts[1]]);
      if (post.rowCount) await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: `${actor.displayName ?? 'A player'} is now **${(interaction.data.values?.[0] ?? '').replaceAll('_', ' ')}**.`, notifyDiscordUserIds: [] });
      return { type: 7, data: lfgCard(session, { discussionThreadId: post.rows[0]?.discussion_thread_id }) };
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'regular' && parts[1] === 'create' && actor.guildId) {
    const [sourceSessionId, cadence] = (interaction.data.values?.[0] ?? '').split('|');
    try {
      await planner.createRegularGameNight({ guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, sourceSessionId, cadence });
      const panel = regularGameNightPanel(await planner.listHostedUpcomingSessions(actor.guildId, actor.discordUserId), await planner.listRegularGameNights(actor.guildId, actor.discordUserId));
      return { type: 7, data: panel };
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'feedback-notify' && feedbackNotifications) {
    await identity.recordDiscordUser(actor);
    const settings = await feedbackNotifications.getSettings(actor.discordUserId);
    const enabled = interaction.data.values?.[0] === 'on';
    const next = await feedbackNotifications.saveSettings(actor.discordUserId, parts[1] === 'owner'
      ? { ...settings, ownerUpdatesEnabled: enabled }
      : { ...settings, participantUpdatesEnabled: enabled });
    return { type: 7, data: feedbackNotificationPanel(next) };
  }
  if (interaction.type === 3 && parts[0] === 'onboard') {
    if (!await configuredGuild()) return ephemeral('This GamePlan card is no longer available because GamePlan is no longer set up in this server. Ask an admin to run **/gameplan server**.');
    if (parts[1] === 'help') return helpResponse();
    if (parts[1] === 'start') {
      await identity.recordDiscordUser(actor);
      return browserLinkResponse('Open your private GamePlan link. It expires in 10 minutes and is only for you.', await issueBrowserUrl(actor));
    }
  }
  if (interaction.type === 3 && parts[0] === 'plan') {
    if (!actor.guildId) return ephemeral('Run **/gameplan start** in a server to plan with that group.');
    if (!await configuredGuild()) return ephemeral('GamePlan has not been set up in this server yet. Ask an admin to run **/gameplan server**.');
    await identity.recordDiscordUser(actor);
    if (parts[1] === 'pick-game') {
      const timezone = notifications ? (await notifications.getSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId })).timezone : 'Europe/London';
      const flow = await flows.create({ kind: 'party', guildId: actor.guildId, discordUserId: actor.discordUserId, payload: { timezone } });
      const picker = await partyPickerFor(flow.id);
      if (!picker.length) return { type: 7, data: { content: 'There is nobody else ready to choose yet. Ask friends to use **/gameplan invite**, then link and sync Steam before planning together.', components: [] } };
      return { type: 7, data: { content: '**Pick a game**\nChoose who is likely to play. GamePlan will show games that fit this group.', components: picker } };
    }
    if (parts[1] === 'decide-together') {
      if (!rallies) return ephemeral('Game voting is not available right now.');
      const timezone = notifications ? (await notifications.getSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId })).timezone : 'Europe/London';
      const flow = await flows.create({ kind: 'rally', guildId: actor.guildId, discordUserId: actor.discordUserId, payload: { timezone } });
      return { type: 7, data: { content: '**Decide together**\nSet when you expect to play. The game can stay undecided until attendees rank their choices.', components: rallyDatePicker(flow.id, timezone) } };
    }
    if (parts[1] === 'voice-now') {
      if (!rallies) return ephemeral('Voice-channel planning is not available right now.');
      try {
        const voice = await database.query(`SELECT channel_id FROM voice_channel_members
          WHERE guild_id=$1 AND discord_user_id=$2 AND observed_at > now() - interval '5 minutes'`, [actor.guildId, actor.discordUserId]);
        if (!voice.rowCount) throw new Error('I cannot see you in a fresh, visible voice-channel roster. Join a voice channel, wait a moment, then try again.');
        const visible = await bot.visibleVoiceChannels(actor.guildId);
        if (!visible.some((channel) => channel.id === voice.rows[0].channel_id)) throw new Error('Your current voice channel is not visible to GamePlan. Ask an admin to grant the bot View Channel there, or choose another channel.');
        const gameVote = await rallies.create({ guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, startsAt: new Date(), voiceChannelId: voice.rows[0].channel_id, rosterSource: 'voice' });
        const refreshed = await rallies.refreshVoiceRoster({ rallyId: gameVote.id, hostDiscordUserId: actor.discordUserId });
        await publishRally(refreshed);
        return { type: 7, data: { content: `Started a game vote from <#${refreshed.voiceChannelId}>. The public card has the live roster; start the game vote when you are ready to decide.`, components: [] } };
      } catch (error) { return ephemeral(error.message); }
    }
    return ephemeral('This planning choice is no longer available. Run **/gameplan start** again.');
  }
  if (interaction.type === 3 && parts[0] === 'setup') {
    if (!actor.guildId || !isGuildAdmin(actor.guildPermissions)) return ephemeral('Only a server admin can change GamePlan setup.');
    const selected = interaction.data.values?.[0]; let policy;
    if (selected && parts[1] === 'default-channel') {
      let channels;
      try { channels = await bot.sendableTextChannels(actor.guildId); } catch { return ephemeral('GamePlan cannot check its channel permissions right now. Try again in a moment.'); }
      if (!channels.some((channel) => channel.id === selected)) return ephemeral('GamePlan cannot view and post to that text channel. Choose another channel.');
    }
    await identity.recordDiscordUser({ ...actor, establishGuild: true });
    if (parts[1] === 'done') {
      const current = await guildPolicy.get(actor.guildId);
      if (!current.defaultLfgChannelId) return ephemeral('Choose a **Session Feed** channel before finishing setup. Every confirmed session will be published there automatically.');
      return { type: 7, data: { content: `**GamePlan setup saved.** Every confirmed session will be published automatically in <#${current.defaultLfgChannelId}>.`, components: [] } };
    }
    if (parts[1] === 'default-channel' && selected) policy = await guildPolicy.addAllowedChannel({ guildId: actor.guildId, channelId: selected, actorId: actor.discordUserId, makeDefault: true });
    else return ephemeral('Choose the channel that should be this server’s Session Feed.');
    return setupPanel({ update: true });
  }
  if (interaction.type === 3 && parts[0] === 'notify' && notifications && actor.guildId) {
    const settings = await notifications.getSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId });
    if (parts[1] === 'quiet') return { type: 9, data: { custom_id: 'notify:quiet-submit', title: 'Timezone and quiet hours', components: [
      { type: 1, components: [{ type: 4, custom_id: 'timezone', label: 'Timezone', style: 1, value: settings.timezone, required: true, placeholder: 'Europe/London' }] },
      { type: 1, components: [{ type: 4, custom_id: 'quiet-start', label: 'Quiet start (HH:MM, optional)', style: 1, value: settings.quietStart ?? '', required: false }] },
      { type: 1, components: [{ type: 4, custom_id: 'quiet-end', label: 'Quiet end (HH:MM, optional)', style: 1, value: settings.quietEnd ?? '', required: false }] },
    ] } };
    if (parts[1] === 'mutes') {
      const games = await identity.getOwnedGames(actor.discordUserId, { pageSize: 25 });
      const muted = settings.mutedGames;
      const choices = [...muted, ...games.games.filter((game) => !muted.some((entry) => entry.appId === game.appId))].slice(0, 25);
      const back = { type: 1, components: [{ type: 2, style: 2, custom_id: 'notify:back', label: 'Back to notifications' }] };
      const components = choices.length ? [
        { type: 1, components: [{ type: 3, custom_id: 'notify:toggle-mute', placeholder: 'Choose an owned game', min_values: 1, max_values: 1, options: choices.map((game) => ({ label: game.name.slice(0, 100), value: String(game.appId), default: muted.some((entry) => entry.appId === game.appId) })) }] },
        back,
      ] : [back];
      return { type: 7, data: { content: `**Muted games**\n${muted.length ? muted.map((game) => `• ${game.name}`).join('\n') : 'None'}\n\nChoose an owned game to mute. Selecting a muted game removes its mute.`, components } };
    }
    if (parts[1] === 'back') return { type: 7, data: notificationPanel(settings) };
    if (parts[1] === 'toggle-mute') {
      const appId = Number(interaction.data.values?.[0]);
      const next = settings.mutedGames.some((game) => game.appId === appId) ? await notifications.unmuteGame({ guildId: actor.guildId, discordUserId: actor.discordUserId, appId }) : await notifications.muteGame({ guildId: actor.guildId, discordUserId: actor.discordUserId, appId });
      return { type: 7, data: notificationPanel(next) };
    }
    const values = interaction.data.values ?? [];
    let next = settings;
    if (parts[1] === 'reminder-delivery') next = await notifications.saveSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId, ...settings, reminderDelivery: values[0] });
    if (parts[1] === 'reminder-leads') next = await notifications.saveSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId, ...settings, reminderLeadMinutes: values.map(Number) });
    if (parts[1] === 'lfg-delivery') next = await notifications.saveSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId, ...settings, lfgAlertDelivery: values[0] });
    if (parts[1] === 'game-night-change-delivery') next = await notifications.saveSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId, ...settings, gameNightChangeDelivery: values[0] });
    return { type: 7, data: notificationPanel(next) };
  }
  if (interaction.type === 5 && interaction.data?.custom_id === 'notify:quiet-submit' && notifications && actor.guildId) {
    const settings = await notifications.getSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId });
    try {
      const next = await notifications.saveSettings({ guildId: actor.guildId, discordUserId: actor.discordUserId, ...settings, timezone: componentValue(interaction, 'timezone'), quietStart: componentValue(interaction, 'quiet-start'), quietEnd: componentValue(interaction, 'quiet-end') });
      return { type: 4, data: { flags: 64, ...notificationPanel(next) } };
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 5 && parts[0] === 'lfg' && /^[0-9a-f-]{36}$/.test(parts[1]) && parts[2] === 'cancel-submit') {
    const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1 AND guild_id=$2', [parts[1], actor.guildId]);
    if (!post.rowCount) return { type: 4, data: { flags: 64, content: 'This session cancellation control is no longer available.' } };
    try {
      const session = await planner.getSession(parts[1], actor.discordUserId);
      const cancelled = await planner.cancelSession({ id: parts[1], guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, cancellationReason: componentValue(interaction, 'cancellation-reason') });
      await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: `${actor.displayName ?? 'The host'} cancelled this session${cancelled.cancellationReason ? `: ${cancelled.cancellationReason}` : '.'}`, notifyDiscordUserIds: session?.rsvps.filter((r) => r.response === 'accepted').map((r) => r.discordUserId) });
      return { type: 7, data: cancelledLfgCard(session, cancelled) };
    } catch (error) { return { type: 4, data: { flags: 64, content: error.message } }; }
  }
  if (interaction.type === 5 && parts[0] === 'party' && parts[1] === 'rules') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.party || !flow.payload?.appId) return { type: 4, data: { flags: 64, content: 'This game settings form has expired. Run **/gameplan start** again.' } };
    try {
      const state = await planner.partyState(actor.guildId, actor.discordUserId, flow.payload.party);
      const game = state.games.find((candidate) => candidate.appId === flow.payload.appId);
      if (!game) throw new Error('That game is no longer available for the selected people.');
      await flows.update({ id: flow.id, kind: 'party', discordUserId: actor.discordUserId, payload: { ...flow.payload, pendingRule: { minPlayers: Number(componentValue(interaction, 'min-players')), maxPlayers: Number(componentValue(interaction, 'max-players')) } } });
      return { type: 7, data: { content: `Set who needs to own **${game.title}**.`, components: ownershipPicker(flow.id) } };
    } catch (error) { return { type: 4, data: { flags: 64, content: error.message } }; }
  }
  if (interaction.type === 3 && parts[0] === 'rules' && parts[1] === 'edit') {
    const rules = await planner.listGuildGameRules(actor.guildId);
    const rule = rules.find((candidate) => candidate.steam_app_id === Number(interaction.data.values?.[0]));
    return rule ? editRuleModal(rule) : ephemeral('That game setting is no longer available. Run **/gameplan games** again.');
  }
  if (interaction.type === 5 && parts[0] === 'rules' && parts[1] === 'save') {
    try {
      const rule = (await planner.listGuildGameRules(actor.guildId)).find((candidate) => candidate.steam_app_id === Number(parts[2]));
      if (!rule) throw new Error('That game setting is no longer available.');
      const ownership = componentValue(interaction, 'ownership').trim().toLowerCase();
      if (!['all', 'one'].includes(ownership)) throw new Error('Ownership must be “all” or “one”.');
      await planner.saveGuildGameRule({ guildId: actor.guildId, steamAppId: rule.steam_app_id, gameName: rule.game_name, minPlayers: Number(componentValue(interaction, 'min-players')), maxPlayers: Number(componentValue(interaction, 'max-players')), requiresAllOwners: ownership === 'all', configuredByDiscordUserId: actor.discordUserId });
      return ephemeral(`Saved **${rule.game_name ?? `Steam app ${rule.steam_app_id}`}**. Existing sessions keep their original rule snapshot; future sessions use this update.`);
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'rally' && ['date', 'time', 'voice', 'manual'].includes(parts[1])) {
    const flow = await flows.get({ id: parts[2], kind: 'rally', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !rallies) return ephemeral('This game-vote setup has expired. Run **/gameplan start** again.');
    if (parts[1] === 'date') {
      const date = interaction.data.values?.[0];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return ephemeral('Choose a valid date.');
      await flows.update({ id: flow.id, kind: 'rally', discordUserId: actor.discordUserId, payload: { ...flow.payload, date } });
      return { type: 7, data: { content: `Date: **${date}** (${flow.payload.timezone}). Choose a time.`, components: rallyTimePicker(flow.id, date, flow.payload.timezone) } };
    }
    if (parts[1] === 'time') {
      const time = interaction.data.values?.[0];
      if (!flow.payload?.date || !/^\d{2}:\d{2}$/.test(time ?? '')) return ephemeral('Choose a valid time.');
      await flows.update({ id: flow.id, kind: 'rally', discordUserId: actor.discordUserId, payload: { ...flow.payload, time } });
      return { type: 7, data: { content: `**${flow.payload.date} ${time} ${flow.payload.timezone}**\nChoose a voice channel to make attendance match the people there, or use manual attendance.`, components: rallyRosterPicker(flow.id) } };
    }
    if (!flow.payload?.date || !flow.payload?.time) return ephemeral('Choose the game-vote date and time first.');
    try {
      let voiceChannelId = null; let rosterSource = 'manual';
      if (parts[1] === 'voice') {
        voiceChannelId = interaction.data.values?.[0];
        const visible = await bot.visibleVoiceChannels(actor.guildId);
        if (!visible.some((channel) => channel.id === voiceChannelId)) throw new Error('Choose a voice channel that GamePlan can view.');
        rosterSource = 'voice';
      }
      const rally = await rallies.create({ guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, startsAt: zonedStartAt(flow.payload.date, flow.payload.time, flow.payload.timezone), voiceChannelId, rosterSource });
      const current = rosterSource === 'voice' ? await rallies.refreshVoiceRoster({ rallyId: rally.id, hostDiscordUserId: actor.discordUserId }) : rally;
      await publishRally(current);
      return { type: 7, data: { content: `Game vote posted in this channel for **${new Date(current.startsAt).toLocaleString()}**. The game stays undecided until you start the ranked-choice vote.`, components: [] } };
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'rally-vote') {
    const flow = await flows.get({ id: parts[2], kind: 'rally-vote', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !rallies) return ephemeral('This voting panel has expired. Click **Rank games** on the game-vote card again.');
    const rally = await rallies.get(flow.payload.rallyId, actor.discordUserId);
    if (!rally || rally.state !== 'polling') return ephemeral('This game vote is no longer accepting rankings.');
    if (parts[1] === 'page') {
      const next = { ...flow, payload: { ...flow.payload, page: Number(parts[3]) } };
      await flows.update({ id: flow.id, kind: 'rally-vote', discordUserId: actor.discordUserId, payload: next.payload });
      return { type: 7, data: votePanel(next, rally) };
    }
    if (parts[1] === 'pick') {
      const appId = Number(interaction.data.values?.[0]);
      if (!rally.candidates.some((candidate) => candidate.appId === appId)) return ephemeral('Choose a game from this game vote’s candidates.');
      const choices = [...new Set([...(flow.payload.choices ?? []), appId])].slice(0, 3);
      if (choices.length === 3) {
        await rallies.castVote({ rallyId: rally.id, discordUserId: actor.discordUserId, appIds: choices });
        return { type: 7, data: { content: 'Your three ranked choices are saved. You can change them by clicking **Rank games** again.', components: [] } };
      }
      const next = { ...flow, payload: { ...flow.payload, choices, page: 0 } };
      await flows.update({ id: flow.id, kind: 'rally-vote', discordUserId: actor.discordUserId, payload: next.payload });
      return { type: 7, data: votePanel(next, rally) };
    }
    if (parts[1] === 'submit') {
      await rallies.castVote({ rallyId: rally.id, discordUserId: actor.discordUserId, appIds: flow.payload.choices ?? [] });
      return { type: 7, data: { content: (flow.payload.choices ?? []).length ? 'Your ranked choices are saved.' : 'You skipped voting; you can submit a ranking later from the game-vote card.', components: [] } };
    }
  }
  if (interaction.type === 3 && parts[0] === 'rally-lock') {
    const flow = await flows.get({ id: parts[2], kind: 'rally-lock', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !rallies) return ephemeral('This choice panel has expired. Click **Choose game** on the game-vote card again.');
    const rally = await rallies.get(flow.payload.rallyId, actor.discordUserId);
    if (!rally || rally.hostDiscordUserId !== actor.discordUserId) return ephemeral('Only the game-vote host can choose a game.');
    if (parts[1] === 'page') {
      const next = { ...flow, payload: { ...flow.payload, page: Number(parts[3]) } };
      await flows.update({ id: flow.id, kind: 'rally-lock', discordUserId: actor.discordUserId, payload: next.payload });
      return { type: 7, data: lockPanel(next, rally) };
    }
    if (parts[1] === 'pick') {
      try {
        const locked = await rallies.lock({ rallyId: rally.id, hostDiscordUserId: actor.discordUserId, appId: Number(interaction.data.values?.[0]) });
        await sendInvites(locked.session);
        const publication = await publishSessionToFeed(locked.session);
        const post = await database.query('SELECT * FROM rally_posts WHERE rally_id=$1 AND guild_id=$2', [rally.id, actor.guildId]);
        if (post.rowCount) await bot.edit(post.rows[0].channel_id, post.rows[0].message_id, rallyCard(locked.rally));
        return { type: 7, data: { content: `**${locked.session.game.title}** is locked. The session has its own immutable roster and rule snapshot.${publication.published ? ` It was published in <#${publication.channelId}>.` : ` It could not be published to the Session Feed: ${publication.error}`}`, components: [] } };
      } catch (error) { return ephemeral(error.message); }
    }
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'members') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId) return { type: 4, data: { flags: 64, content: 'This people picker has expired. Run **/gameplan start** again.' } };
    const party = interaction.data.values ?? [];
    const state = await planner.partyState(actor.guildId, actor.discordUserId, party);
    if (!state.games.length) return { type: 7, data: { content: 'No shared Steam games were found for those people. Choose different people or sync libraries first.', components: await partyPickerFor(flow.id, party) } };
    await flows.update({ id: flow.id, kind: 'party', discordUserId: actor.discordUserId, payload: { party, gamePage: 0 } });
    return { type: 7, data: { content: `${partySummary(state.party)}\n\nChoose a shared game.`, components: gamePicker(flow.id, state.games) } };
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'change') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId) return { type: 4, data: { flags: 64, content: 'This people picker has expired. Run **/gameplan start** again.' } };
    const picker = await partyPickerFor(flow.id, flow.payload?.party ?? []);
    if (!picker.length) return { type: 7, data: { content: 'There is nobody else ready to choose yet. Ask friends to use **/gameplan invite**, then link and sync Steam before planning together.', components: [] } };
    return { type: 7, data: { content: 'Choose different people. You are included automatically.', components: picker } };
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'games') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.party) return { type: 4, data: { flags: 64, content: 'This game picker has expired. Run **/gameplan start** again.' } };
    const state = await planner.partyState(actor.guildId, actor.discordUserId, flow.payload.party);
    if (state.unavailable.length || !state.games.length) return { type: 4, data: { flags: 64, content: 'The shared games for these people are no longer available. Choose people again.' } };
    const page = gamePage(state.games, Number(parts[3]));
    return { type: 7, data: { content: `${partySummary(state.party)}\n\nChoose a shared game.`, components: gamePicker(flow.id, state.games, page) } };
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'game') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.party) return { type: 4, data: { flags: 64, content: 'This game picker has expired. Run **/gameplan start** again.' } };
    const state = await planner.partyState(actor.guildId, actor.discordUserId, flow.payload.party);
    const game = state.games.find((candidate) => candidate.appId === Number(interaction.data.values?.[0]));
    if (!game) return { type: 4, data: { flags: 64, content: 'That game is no longer available for the selected people. Choose people again.' } };
    await flows.update({ id: flow.id, kind: 'party', discordUserId: actor.discordUserId, payload: { ...flow.payload, appId: game.appId } });
    if (game.ruleSource === 'unconfigured') return gameRulesModal(flow.id, game, state.party.length);
    return { type: 7, data: { content: `**${game.title}** selected. Choose the date.`, components: datePicker(flow.id, flow.payload?.timezone) } };
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'ownership') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.party || !flow.payload?.appId || !flow.payload?.pendingRule) return { type: 4, data: { flags: 64, content: 'This game ownership picker has expired. Run **/gameplan start** again.' } };
    try {
      const state = await planner.partyState(actor.guildId, actor.discordUserId, flow.payload.party);
      const game = state.games.find((candidate) => candidate.appId === flow.payload.appId);
      if (!game) throw new Error('That game is no longer available for the selected people.');
      await planner.saveGuildGameRule({ guildId: actor.guildId, steamAppId: game.appId, gameName: game.title, ...flow.payload.pendingRule, requiresAllOwners: interaction.data.values?.[0] === 'all', configuredByDiscordUserId: actor.discordUserId });
      return { type: 7, data: { content: `**${game.title}** is now configured for this server. Choose the date.`, components: datePicker(flow.id) } };
    } catch (error) { return { type: 4, data: { flags: 64, content: error.message } }; }
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'date') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId }); const date = interaction.data.values?.[0];
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.appId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return { type: 4, data: { flags: 64, content: 'This date picker has expired. Run **/gameplan start** again.' } };
    await flows.update({ id: flow.id, kind: 'party', discordUserId: actor.discordUserId, payload: { ...flow.payload, date } });
    return { type: 7, data: { content: `Date: **${date}** (${flow.payload?.timezone ?? 'Europe/London'}). Choose a time.`, components: timePicker(flow.id, date, flow.payload?.timezone) } };
  }
  if (interaction.type === 3 && parts[0] === 'party' && parts[1] === 'time') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId }); const time = interaction.data.values?.[0];
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.appId || !flow.payload?.date || !/^\d{2}:\d{2}$/.test(time ?? '')) return { type: 4, data: { flags: 64, content: 'This time picker has expired. Run **/gameplan start** again.' } };
    await flows.update({ id: flow.id, kind: 'party', discordUserId: actor.discordUserId, payload: { ...flow.payload, time } });
    const state = await planner.partyState(actor.guildId, actor.discordUserId, flow.payload.party); const game = state.games.find((candidate) => candidate.appId === flow.payload.appId);
    return planModal(flow.id, game?.title ?? 'game night', flow.payload.date, time);
  }
  if (interaction.type === 5 && parts[0] === 'party' && parts[1] === 'create') {
    const flow = await flows.get({ id: parts[2], kind: 'party', discordUserId: actor.discordUserId });
    if (!flow || flow.guild_id !== actor.guildId || !flow.payload?.party || !flow.payload?.appId || !flow.payload?.date || !flow.payload?.time) return { type: 4, data: { flags: 64, content: 'This session form has expired. Run **/gameplan start** again.' } };
    try {
      const session = await planner.createSession({ guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, party: flow.payload.party, appId: flow.payload.appId, startsAt: zonedStartAt(flow.payload.date, flow.payload.time, flow.payload.timezone), hostNote: componentValue(interaction, 'host-note') });
      await sendInvites(session);
      await flows.update({ id: flow.id, kind: 'party', discordUserId: actor.discordUserId, payload: { ...flow.payload, sessionId: session.id } });
      const publication = await publishSessionToFeed(session);
      return ephemeral(`**${session.game.title}** is planned for ${new Date(session.startsAt).toLocaleString()}. Your invitees will receive Discord DMs.${publication.published ? ` It was published in <#${publication.channelId}>.` : ` It could not be published to the Session Feed: ${publication.error}`}`);
    } catch (error) {
      return ephemeral(`Could not create the session: ${error.message}`);
    }
  }
  if (interaction.type === 3 && parts[0] === 'rally' && /^[0-9a-f-]{36}$/.test(parts[1])) {
    if (!rallies) return ephemeral('Game voting is not available right now.');
    const post = await database.query(`SELECT * FROM rally_posts WHERE rally_id=$1 AND guild_id=$2 AND channel_id=$3 AND message_id=$4`, [parts[1], actor.guildId, interaction.channel_id, interaction.message?.id]);
    if (!post.rowCount) return ephemeral('This game-vote control is no longer valid in this server.');
    await identity.recordDiscordUser(actor);
    try {
      if (parts[2] === 'join' || parts[2] === 'leave') {
        const rally = await rallies.setMember({ rallyId: parts[1], discordUserId: actor.discordUserId, status: parts[2] === 'join' ? 'in' : 'out' });
        return { type: 7, data: rallyCard(rally) };
      }
      if (parts[2] === 'refresh') {
        const rally = await rallies.refreshVoiceRoster({ rallyId: parts[1], hostDiscordUserId: actor.discordUserId });
        return { type: 7, data: rallyCard(rally) };
      }
      if (parts[2] === 'open-poll') {
        const opened = await rallies.openPoll({ rallyId: parts[1], hostDiscordUserId: actor.discordUserId });
        if (!opened.rally.candidates.length) return ephemeral(`No configured game settings currently fit this game-vote roster.${opened.unconfiguredGames.length ? ` ${opened.unconfiguredGames.length} owned games still need player and ownership settings; configure one through **/gameplan games** or while planning a session.` : ''}`);
        return { type: 7, data: rallyCard(opened.rally) };
      }
      if (parts[2] === 'vote') {
        const rally = await rallies.get(parts[1], actor.discordUserId);
        if (!rally || rally.state !== 'polling') throw new Error('This game vote is not accepting rankings.');
        const flow = await flows.create({ kind: 'rally-vote', guildId: actor.guildId, discordUserId: actor.discordUserId, payload: { rallyId: rally.id, choices: rally.viewerRankings.map((ranking) => ranking.appId), page: 0 } });
        return ephemeral(votePanel(flow, rally).content, votePanel(flow, rally).components);
      }
      if (parts[2] === 'result') {
        const result = await rallies.result(parts[1]);
        if (!result.ranked.length) return ephemeral('No candidate games are available for this game vote.');
        const winner = result.ranked[0];
        const ties = result.tiedAppIds.length > 1 ? `\n\nTie: ${result.tiedAppIds.map((appId) => result.ranked.find((entry) => entry.appId === appId)?.title).join(', ')}. The host chooses the final game.` : '';
        return ephemeral(`**Game vote result**\n${result.ranked.slice(0, 10).map((candidate, index) => `${index + 1}. **${candidate.title}** — ${candidate.potentialParticipants} can play · ${candidate.preferencePoints} preference points`).join('\n')}${ties}\n\nThe host can use **Choose game** on the game-vote card to make the final choice.`);
      }
      if (parts[2] === 'lock') {
        const rally = await rallies.get(parts[1], actor.discordUserId);
        if (!rally || rally.hostDiscordUserId !== actor.discordUserId) throw new Error('Only the game-vote host can choose a game.');
        const flow = await flows.create({ kind: 'rally-lock', guildId: actor.guildId, discordUserId: actor.discordUserId, payload: { rallyId: rally.id, page: 0 } });
        const panel = lockPanel(flow, rally);
        return ephemeral(panel.content, panel.components);
      }
      if (parts[2] === 'cancel') {
        const rally = await rallies.cancel({ rallyId: parts[1], hostDiscordUserId: actor.discordUserId });
        return { type: 7, data: rallyCard(rally) };
      }
    } catch (error) { return ephemeral(error.message); }
  }
  if (interaction.type === 3 && parts[0] === 'rsvp' && /^[0-9a-f-]{36}$/.test(parts[1])) {
    const session = await planner.respondToSession({ id: parts[1], discordUserId: actor.discordUserId, response: parts[2] });
    const post = await database.query('SELECT * FROM session_lfg_posts WHERE game_session_id=$1', [session.id]);
    try {
      await updateLfgCard({ session, post, bot });
      await postSessionActivity({
        threadId: post.rows[0]?.discussion_thread_id,
        bot,
        content: `${actor.displayName ?? 'A player'} ${parts[2]} the session.`,
        notifyDiscordUserIds: [session.hostDiscordUserId].filter((discordUserId) => discordUserId !== actor.discordUserId),
      });
    } catch (error) {
      console.warn(`Could not update GamePlan Session Feed card: ${error.message}`);
    }
    return { type: 7, data: { ...sessionEmbed(session), content: `RSVP recorded: ${parts[2]}.` } };
  }
  if (interaction.type === 3 && parts[0] === 'lfg' && /^[0-9a-f-]{36}$/.test(parts[1])) {
    const post = await database.query(`SELECT p.*, s.host_discord_user_id
      FROM session_lfg_posts p JOIN game_sessions s ON s.id=p.game_session_id
      WHERE p.game_session_id=$1 AND p.guild_id=$2 AND p.channel_id=$3 AND p.message_id=$4`, [parts[1], actor.guildId, interaction.channel_id, interaction.message?.id]);
    if (!post.rowCount) return { type: 4, data: { flags: 64, content: 'This published-session control is not valid in this server.' } };
    if (parts[2] === 'discuss') {
      const session = await planner.getSession(parts[1], post.rows[0].host_discord_user_id);
      if (!session) return { type: 4, data: { flags: 64, content: 'This session is no longer available.' } };
      const thread = await createLfgDiscussion({ session, post, bot, database });
      return { type: 4, data: { flags: 64, content: 'Discussion is ready.', components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open discussion', url: `https://discord.com/channels/${actor.guildId}/${thread.id}` }] }] } };
    }
    await identity.recordDiscordUser(actor);
    if (parts[2] === 'transfer') {
      const session = await planner.getSession(parts[1], actor.discordUserId);
      if (!session || session.hostDiscordUserId !== actor.discordUserId) return { type: 4, data: { flags: 64, content: 'Only the current host can transfer Host.' } };
      const candidates = session.rsvps.filter((r) => r.response === 'accepted' && r.discordUserId !== actor.discordUserId);
      if (!candidates.length) return { type: 4, data: { flags: 64, content: 'A confirmed participant is needed before Host can be transferred.' } };
      return { type: 7, data: { content: 'Choose the confirmed participant who will become Host.', components: [{ type: 1, components: [{ type: 3, custom_id: `lfg:${parts[1]}:transfer-to`, placeholder: 'Choose new host', min_values: 1, max_values: 1, options: candidates.map((candidate) => ({ label: candidate.displayName.slice(0, 100), value: candidate.discordUserId })) }] }] } };
    }
    if (parts[2] === 'transfer-to') {
      try {
        const session = await planner.transferHost({ id: parts[1], guildId: actor.guildId, hostDiscordUserId: actor.discordUserId, newHostDiscordUserId: interaction.data.values?.[0] });
        const newHost = session.rsvps.find((r) => r.discordUserId === session.hostDiscordUserId)?.displayName ?? 'A player';
        await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: `${newHost} is now the host.`, notifyDiscordUserIds: session.rsvps.filter((r) => r.response === 'accepted').map((r) => r.discordUserId) });
        return { type: 7, data: lfgCard(session, { discussionThreadId: post.rows[0].discussion_thread_id }) };
      } catch (error) { return { type: 4, data: { flags: 64, content: error.message } }; }
    }
    if (parts[2] === 'cancel') {
      const session = await planner.getSession(parts[1], actor.discordUserId);
      if (!session || session.hostDiscordUserId !== actor.discordUserId) return { type: 4, data: { flags: 64, content: 'Only the current host can cancel this session.' } };
      return cancelModal(parts[1]);
    }
    if (parts[2] === 'complete') {
      try {
        const session = await planner.getSession(parts[1], actor.discordUserId);
        if (!session) throw new Error('This session is no longer available.');
        await planner.completeSession({ id: parts[1], guildId: actor.guildId, hostDiscordUserId: actor.discordUserId });
        await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: `${actor.displayName ?? 'The host'} marked this session complete.`, notifyDiscordUserIds: session.rsvps.filter((r) => r.response === 'accepted').map((r) => r.discordUserId) });
        return { type: 7, data: completedLfgCard(session) };
      } catch (error) { return { type: 4, data: { flags: 64, content: error.message } }; }
    }
    if (parts[2] === 'host') return { type: 4, data: { flags: 64, content: 'Host controls', components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open GamePlan', url: await issueBrowserUrl(actor) }] }] } };
    if (parts[2] === 'join') {
      try {
        const session = await planner.joinLfg({ id: parts[1], guildId: actor.guildId, discordUserId: actor.discordUserId });
        await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: `${actor.displayName ?? 'A player'} joined the session.`, notifyDiscordUserIds: [session.hostDiscordUserId].filter((discordUserId) => discordUserId !== actor.discordUserId) });
        return { type: 7, data: lfgCard(session, { discussionThreadId: post.rows[0].discussion_thread_id }) };
      } catch (error) {
        return { type: 4, data: { flags: 64, content: error.message, components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Open GamePlan', url: await issueBrowserUrl(actor) }] }] } };
      }
    }
    if (parts[2] === 'leave') {
      try {
        const result = await planner.leaveLfg({ id: parts[1], guildId: actor.guildId, discordUserId: actor.discordUserId });
        if (result.cancelled) return { type: 7, data: cancelledLfgCard() };
        await postSessionActivity({ threadId: post.rows[0].discussion_thread_id, bot, content: `${actor.displayName ?? 'A player'} left the session.`, notifyDiscordUserIds: [result.hostDiscordUserId].filter((discordUserId) => discordUserId !== actor.discordUserId) });
        return { type: 7, data: lfgCard(result, { discussionThreadId: post.rows[0].discussion_thread_id }) };
      } catch (error) { return { type: 4, data: { flags: 64, content: error.message } }; }
    }
  }
  return interactionResponse(interaction);
}

import { newId } from './tokens.mjs';
import { gameFitsParty, gamePolicy } from './game-policy.mjs';

function normaliseParty(hostDiscordUserId, party) {
  const ids = [...new Set([hostDiscordUserId, ...(party ?? [])])];
  if (ids.length > 100) throw new Error('A GamePlan session can contain at most 100 people.');
  if (ids.some((id) => typeof id !== 'string' || !/^\d{5,25}$/.test(id))) throw new Error('Party members must be Discord user IDs.');
  return ids;
}

function serialiseGame(row, partySize) {
  const catalogPolicy = gamePolicy(row.app_id, row.store_title);
  const hasGuildRule = row.min_players != null && row.max_players != null;
  const hasExternalDefault = row.external_min_players != null && row.external_max_players != null;
  const requiresAllOwners = hasGuildRule ? row.requires_all_owners : true;
  const policy = hasGuildRule ? {
    ...catalogPolicy,
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    policyNote: 'Player count configured by this Discord server.',
    ruleSource: 'guild',
  } : hasExternalDefault ? {
    ...catalogPolicy,
    minPlayers: row.external_min_players ?? catalogPolicy.minPlayers,
    maxPlayers: row.external_max_players ?? catalogPolicy.maxPlayers,
    policyNote: 'Player-count default inferred from IGDB metadata. Confirm it before inviting people.',
    ruleSource: 'external',
  } : {
    ...catalogPolicy,
    ruleSource: catalogPolicy.minPlayers == null || catalogPolicy.maxPlayers == null ? 'unconfigured' : 'catalog',
  };
  const playerCountFits = gameFitsParty(policy, partySize);
  const ownershipFits = !requiresAllOwners || Number(row.owner_count) === partySize;
  return {
    appId: row.app_id,
    title: policy.canonicalTitle,
    storeTitle: row.store_title,
    ...policy,
    requiresAllOwners,
    ownerCount: Number(row.owner_count),
    fitsParty: playerCountFits && ownershipFits,
    playerCountFits,
    ownershipFits,
    launchUrl: `steam://run/${row.app_id}`,
  };
}

function serialiseGameSetting(row) {
  const catalogPolicy = gamePolicy(row.app_id, row.store_title);
  const hasGuildRule = row.min_players != null && row.max_players != null;
  const hasCatalogDefault = catalogPolicy.minPlayers != null && catalogPolicy.maxPlayers != null;
  const hasExternalDefault = row.external_min_players != null && row.external_max_players != null;
  const ruleSource = hasGuildRule ? 'guild' : hasCatalogDefault ? 'catalog' : hasExternalDefault ? 'external' : 'unconfigured';
  const policy = hasGuildRule ? {
    minPlayers: row.min_players,
    maxPlayers: row.max_players,
    requiresAllOwners: row.requires_all_owners,
    policyNote: 'Player count configured by this Discord server.',
  } : hasExternalDefault ? {
    minPlayers: row.external_min_players ?? catalogPolicy.minPlayers,
    maxPlayers: row.external_max_players ?? catalogPolicy.maxPlayers,
    requiresAllOwners: true,
    policyNote: 'Player-count default inferred from IGDB metadata. Confirm it or save a server override.',
  } : {
    minPlayers: catalogPolicy.minPlayers,
    maxPlayers: catalogPolicy.maxPlayers,
    requiresAllOwners: true,
    policyNote: catalogPolicy.policyNote,
  };
  return {
    appId: row.app_id,
    title: catalogPolicy.canonicalTitle,
    storeTitle: row.store_title,
    ownerCount: Number(row.owner_count),
    ...policy,
    ruleSource,
    status: ruleSource === 'guild' ? 'server-setting' : ruleSource === 'catalog' ? 'catalog-default' : ruleSource === 'external' ? 'external-default' : 'needs-review',
  };
}

function cadenceWeeks(cadence) {
  if (cadence === 'weekly') return 1;
  if (cadence === 'fortnightly') return 2;
  throw new Error('Choose weekly or fortnightly.');
}

function cadenceName(weeks) { return weeks === 2 ? 'fortnightly' : 'weekly'; }

export class PlannerService {
  constructor({ database }) {
    this.database = database;
  }

  async getPlanner(guildId, discordUserId) {
    if (!guildId) throw new Error('Open GamePlan from a Discord server to plan with a group.');
    const members = await this.database.query(
      `SELECT u.discord_user_id, u.display_name, c.steam_id, c.last_sync_status, c.last_sync_at
       FROM guild_members gm
       JOIN discord_users u ON u.discord_user_id = gm.discord_user_id
       LEFT JOIN steam_connections c ON c.discord_user_id = u.discord_user_id
       WHERE gm.guild_id = $1
       ORDER BY CASE WHEN u.discord_user_id = $2 THEN 0 ELSE 1 END, lower(coalesce(u.display_name, u.discord_user_id))`,
      [guildId, discordUserId],
    );
    return members.rows.map((member) => ({
      discordUserId: member.discord_user_id,
      displayName: member.display_name ?? member.discord_user_id,
      steam: member.steam_id ? { steamId: member.steam_id, syncStatus: member.last_sync_status, lastSyncAt: member.last_sync_at } : null,
    }));
  }

  async getGroup(guildId, discordUserId) {
    const members = await this.getPlanner(guildId, discordUserId);
    const games = await this.database.query(
      `SELECT games.app_id, min(games.name) AS title, array_agg(DISTINCT games.discord_user_id) AS owner_ids
       FROM steam_owned_games games
       JOIN guild_members gm ON gm.discord_user_id = games.discord_user_id AND gm.guild_id = $1
       GROUP BY games.app_id
       ORDER BY lower(min(games.name)), games.app_id`,
      [guildId],
    );
    return { members, games: games.rows.map((game) => ({ appId: game.app_id, title: game.title ?? `Steam app ${game.app_id}`, ownerIds: game.owner_ids ?? [] })) };
  }

  async partyState(guildId, hostDiscordUserId, party) {
    if (!guildId) throw new Error('Open GamePlan from a Discord server to plan with a group.');
    const ids = normaliseParty(hostDiscordUserId, party);
    const members = await this.database.query(
      `SELECT u.discord_user_id, u.display_name, c.steam_id, c.last_sync_status, c.last_sync_at
       FROM guild_members gm
       JOIN discord_users u ON u.discord_user_id = gm.discord_user_id
       LEFT JOIN steam_connections c ON c.discord_user_id = u.discord_user_id
       WHERE gm.guild_id = $1 AND u.discord_user_id = ANY($2::text[])`,
      [guildId, ids],
    );
    if (members.rowCount !== ids.length) throw new Error('Everyone selected must have opened GamePlan in this Discord server first.');
    const byId = new Map(members.rows.map((member) => [member.discord_user_id, member]));
    const ordered = ids.map((id) => byId.get(id));
    const partyMembers = ordered.map((member) => ({
      discordUserId: member.discord_user_id,
      displayName: member.display_name ?? member.discord_user_id,
      steam: member.steam_id ? { steamId: member.steam_id, syncStatus: member.last_sync_status, lastSyncAt: member.last_sync_at } : null,
    }));
    const unavailable = ordered.filter((member) => member.last_sync_status !== 'complete').map((member) => ({
      discordUserId: member.discord_user_id,
      displayName: member.display_name ?? member.discord_user_id,
      reason: !member.steam_id ? 'Steam is not linked.' : member.last_sync_status === 'unavailable' ? 'Steam library is private or unavailable.' : 'Steam library has not been successfully synced.',
    }));
    const games = await this.database.query(
      `SELECT games.app_id, min(games.name) AS store_title, rules.min_players, rules.max_players, rules.requires_all_owners,
              metadata.min_players AS external_min_players, metadata.max_players AS external_max_players,
              count(DISTINCT games.discord_user_id)::int AS owner_count
       FROM steam_owned_games games JOIN steam_connections connections ON connections.discord_user_id=games.discord_user_id AND connections.last_sync_status='complete'
       LEFT JOIN guild_game_rules rules ON rules.guild_id = $2 AND rules.steam_app_id = games.app_id
       LEFT JOIN external_games metadata ON metadata.steam_app_id = games.app_id
       WHERE games.discord_user_id = ANY($1::text[])
       GROUP BY games.app_id, rules.min_players, rules.max_players, rules.requires_all_owners, metadata.min_players, metadata.max_players
       HAVING coalesce(rules.requires_all_owners, true) = false OR count(DISTINCT games.discord_user_id) = cardinality($1::text[])
       ORDER BY min(name)`,
      [ids, guildId],
    );
    return { party: partyMembers, unavailable, games: games.rows.map((game) => serialiseGame(game, ids.length)) };
  }

  async createSession({ guildId, hostDiscordUserId, party, appId, startsAt, hostNote, allowImmediate = false, acceptAll = false }) {
    const partyState = await this.partyState(guildId, hostDiscordUserId, party);
    const game = partyState.games.find((candidate) => candidate.appId === appId);
    if (!game) throw new Error('That game is not in the selected people’s shared Steam library.');
    if (!game.playerCountFits) throw new Error(`This group of ${partyState.party.length} does not fit the player-count rule for ${game.title}.`);
    if (!game.ownershipFits) throw new Error(`Everyone in this session must own ${game.title} under this server’s game rule.`);
    const date = new Date(startsAt);
    if (Number.isNaN(date.getTime()) || (!allowImmediate && date <= new Date()) || (allowImmediate && date.getTime() < Date.now() - 60_000)) throw new Error('Choose a future start time.');
    if (typeof hostNote !== 'string' || hostNote.length > 500) throw new Error('Host note must be at most 500 characters.');

    const id = newId();
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
      `INSERT INTO game_sessions (id, guild_id, host_discord_user_id, steam_app_id, game_name, starts_at, host_note, min_players, max_players, requires_all_owners)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, guildId, hostDiscordUserId, game.appId, game.title, date, hostNote.trim() || null, game.minPlayers, game.maxPlayers, game.requiresAllOwners],
      );
      for (const member of partyState.party) {
        const response = acceptAll || member.discordUserId === hostDiscordUserId ? 'accepted' : 'pending';
        await client.query(
          `INSERT INTO session_rsvps (game_session_id, discord_user_id, response, responded_at)
           VALUES ($1, $2, $3, CASE WHEN $3 = 'accepted' THEN now() ELSE NULL END)`,
          [id, member.discordUserId, response],
        );
      }
      const firstGameId = newId();
      await client.query(
        `INSERT INTO game_night_games (id,game_session_id,position,steam_app_id,game_name)
         VALUES ($1,$2,0,$3,$4)`, [firstGameId,id,game.appId,game.title],
      );
      for (const member of partyState.party) await client.query(
        'INSERT INTO game_night_game_players (game_night_game_id,discord_user_id) VALUES ($1,$2)', [firstGameId,member.discordUserId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getSession(id, hostDiscordUserId);
  }

  async getSession(id, discordUserId) {
    const session = await this.database.query(
      `SELECT s.id, s.guild_id, s.host_discord_user_id, s.steam_app_id, s.game_name, s.starts_at, s.host_note, s.min_players, s.max_players, s.requires_all_owners, s.registration_closed_at, s.completed_at,
              (rules.steam_app_id IS NOT NULL AND (rules.min_players,rules.max_players,rules.requires_all_owners) IS DISTINCT FROM (s.min_players,s.max_players,s.requires_all_owners)) AS rule_changed,
              s.created_at, s.updated_at
       FROM game_sessions s LEFT JOIN guild_game_rules rules ON rules.guild_id=s.guild_id AND rules.steam_app_id=s.steam_app_id
       WHERE s.id = $1 AND s.cancelled_at IS NULL AND (s.host_discord_user_id = $2 OR EXISTS (
         SELECT 1 FROM session_rsvps r WHERE r.game_session_id = s.id AND r.discord_user_id = $2
       ))`,
      [id, discordUserId],
    );
    if (!session.rowCount) return null;
    const rsvps = await this.database.query(
      `SELECT r.discord_user_id, u.display_name, r.response, r.responded_at,live.status AS live_status,live.updated_at AS live_status_updated_at
       FROM session_rsvps r JOIN discord_users u ON u.discord_user_id = r.discord_user_id
       LEFT JOIN session_live_statuses live ON live.game_session_id=r.game_session_id AND live.discord_user_id=r.discord_user_id
       WHERE r.game_session_id = $1 ORDER BY CASE WHEN r.discord_user_id = $2 THEN 0 ELSE 1 END, lower(coalesce(u.display_name, u.discord_user_id))`,
      [id, session.rows[0].host_discord_user_id],
    );
    const gamesTonight = await this.database.query('SELECT id,steam_app_id,game_name,note,status,position FROM game_night_games WHERE game_session_id=$1 ORDER BY position', [id]);
    return {
      id: session.rows[0].id,
      guildId: session.rows[0].guild_id,
      hostDiscordUserId: session.rows[0].host_discord_user_id,
      game: { appId: session.rows[0].steam_app_id, title: session.rows[0].game_name, minPlayers: session.rows[0].min_players ?? gamePolicy(session.rows[0].steam_app_id, session.rows[0].game_name).minPlayers, maxPlayers: session.rows[0].max_players ?? gamePolicy(session.rows[0].steam_app_id, session.rows[0].game_name).maxPlayers, requiresAllOwners: session.rows[0].requires_all_owners ?? true, ruleChanged: session.rows[0].rule_changed, launchUrl: `steam://run/${session.rows[0].steam_app_id}` },
      startsAt: session.rows[0].starts_at,
      registrationClosedAt: session.rows[0].registration_closed_at,
      completedAt: session.rows[0].completed_at,
      hostNote: session.rows[0].host_note,
      createdAt: session.rows[0].created_at,
      updatedAt: session.rows[0].updated_at,
      rsvps: rsvps.rows.map((rsvp) => ({ discordUserId: rsvp.discord_user_id, displayName: rsvp.display_name ?? rsvp.discord_user_id, response: rsvp.response, respondedAt: rsvp.responded_at, liveStatus: rsvp.live_status ?? null, liveStatusUpdatedAt: rsvp.live_status_updated_at ?? null })),
      gamesTonight: gamesTonight.rows.map((game) => ({ id: game.id, appId: game.steam_app_id, title: game.game_name, note: game.note, status: game.status, position: game.position })),
    };
  }

  async listSessions(guildId, discordUserId) {
    const sessions = await this.database.query(
      `SELECT s.id FROM game_sessions s
       WHERE s.guild_id = $1 AND s.cancelled_at IS NULL AND s.completed_at IS NULL AND (s.host_discord_user_id = $2 OR EXISTS (
         SELECT 1 FROM session_rsvps r WHERE r.game_session_id = s.id AND r.discord_user_id = $2
       ))
       ORDER BY s.starts_at ASC`,
      [guildId, discordUserId],
    );
    return Promise.all(sessions.rows.map(({ id }) => this.getSession(id, discordUserId)));
  }

  async listHostedUpcomingSessions(guildId, hostDiscordUserId) {
    const sessions = await this.database.query(
      `SELECT id FROM game_sessions
       WHERE guild_id=$1 AND host_discord_user_id=$2 AND cancelled_at IS NULL AND completed_at IS NULL AND starts_at > now()
       ORDER BY starts_at ASC`, [guildId, hostDiscordUserId],
    );
    return Promise.all(sessions.rows.map(({ id }) => this.getSession(id, hostDiscordUserId)));
  }

  async createRegularGameNight({ guildId, hostDiscordUserId, sourceSessionId, cadence }) {
    if (!guildId) throw new Error('Open GamePlan from a Discord server to make a regular game night.');
    const weeks = cadenceWeeks(cadence);
    const client = await this.database.connect();
    let id;
    try {
      await client.query('BEGIN');
      const source = await client.query(
        `SELECT id FROM game_sessions
         WHERE id=$1 AND guild_id=$2 AND host_discord_user_id=$3 AND starts_at > now()
           AND cancelled_at IS NULL AND completed_at IS NULL AND regular_game_night_id IS NULL FOR UPDATE`,
        [sourceSessionId, guildId, hostDiscordUserId],
      );
      if (!source.rowCount) throw new Error('Choose one of your upcoming Game Nights that is not already regular.');
      id = newId();
      await client.query(
        `INSERT INTO regular_game_nights (id,guild_id,host_discord_user_id,cadence_weeks)
         VALUES ($1,$2,$3,$4)`, [id, guildId, hostDiscordUserId, weeks],
      );
      await client.query(
        `INSERT INTO regular_game_night_members (regular_game_night_id,discord_user_id)
         SELECT $1,discord_user_id FROM session_rsvps WHERE game_session_id=$2`, [id, sourceSessionId],
      );
      await client.query(
        `UPDATE game_sessions SET regular_game_night_id=$2,regular_occurrence_index=0,updated_at=now() WHERE id=$1`,
        [sourceSessionId, id],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    await this.materializeRegularGameNights({ ids: [id] });
    return this.getRegularGameNight(id, hostDiscordUserId);
  }

  async getRegularGameNight(id, discordUserId) {
    const result = await this.database.query(
      `SELECT r.id,r.guild_id,r.host_discord_user_id,r.cadence_weeks,r.active,r.created_at,r.updated_at,
              min(s.starts_at) FILTER (WHERE s.starts_at > now() AND s.cancelled_at IS NULL AND s.completed_at IS NULL) AS next_starts_at
       FROM regular_game_nights r
       LEFT JOIN game_sessions s ON s.regular_game_night_id=r.id
       WHERE r.id=$1 AND (r.host_discord_user_id=$2 OR EXISTS (
         SELECT 1 FROM regular_game_night_members m WHERE m.regular_game_night_id=r.id AND m.discord_user_id=$2
       ))
       GROUP BY r.id`, [id, discordUserId],
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    return { id: row.id, guildId: row.guild_id, hostDiscordUserId: row.host_discord_user_id, cadence: cadenceName(row.cadence_weeks), active: row.active, nextStartsAt: row.next_starts_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  async listRegularGameNights(guildId, discordUserId) {
    const schedules = await this.database.query(
      `SELECT id FROM regular_game_nights WHERE guild_id=$1 AND (host_discord_user_id=$2 OR EXISTS (
         SELECT 1 FROM regular_game_night_members m WHERE m.regular_game_night_id=regular_game_nights.id AND m.discord_user_id=$2
       )) ORDER BY active DESC,created_at DESC`, [guildId, discordUserId],
    );
    return Promise.all(schedules.rows.map(({ id }) => this.getRegularGameNight(id, discordUserId)));
  }

  async updateRegularGameNight({ id, hostDiscordUserId, cadence, active }) {
    const values = []; const assignments = [];
    if (cadence != null) { values.push(cadenceWeeks(cadence)); assignments.push(`cadence_weeks=$${values.length}`); }
    if (active != null) { if (typeof active !== 'boolean') throw new Error('Active must be true or false.'); values.push(active); assignments.push(`active=$${values.length}`); }
    if (!assignments.length) throw new Error('Choose what to change about this regular game night.');
    values.push(id, hostDiscordUserId);
    const updated = await this.database.query(
      `UPDATE regular_game_nights SET ${assignments.join(',')},updated_at=now()
       WHERE id=$${values.length - 1} AND host_discord_user_id=$${values.length} RETURNING id`, values,
    );
    if (!updated.rowCount) throw new Error('Only the host can change this regular game night.');
    if (active !== false) await this.materializeRegularGameNights({ ids: [id] });
    return this.getRegularGameNight(id, hostDiscordUserId);
  }

  async materializeRegularGameNights({ ids } = {}) {
    const schedules = await this.database.query(
      `SELECT r.id,r.cadence_weeks,s.id AS source_session_id,s.guild_id,s.host_discord_user_id,s.steam_app_id,s.game_name,s.starts_at,s.host_note,s.min_players,s.max_players,s.requires_all_owners
       FROM regular_game_nights r JOIN game_sessions s ON s.regular_game_night_id=r.id AND s.regular_occurrence_index=0
       WHERE r.active AND ($1::uuid[] IS NULL OR r.id=ANY($1::uuid[]))`, [ids ?? null],
    );
    const horizon = Date.now() + 90 * 24 * 60 * 60 * 1000;
    for (const schedule of schedules.rows) {
      const existing = await this.database.query('SELECT coalesce(max(regular_occurrence_index),0)::int AS max_index FROM game_sessions WHERE regular_game_night_id=$1', [schedule.id]);
      let index = existing.rows[0].max_index + 1;
      let startsAt = new Date(schedule.starts_at);
      startsAt.setUTCDate(startsAt.getUTCDate() + index * schedule.cadence_weeks * 7);
      while (startsAt.getTime() <= horizon) {
        const occurrenceId = newId();
        const inserted = await this.database.query(
          `INSERT INTO game_sessions (id,guild_id,host_discord_user_id,steam_app_id,game_name,starts_at,host_note,min_players,max_players,requires_all_owners,regular_game_night_id,regular_occurrence_index)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (regular_game_night_id,regular_occurrence_index) WHERE regular_game_night_id IS NOT NULL DO NOTHING
           RETURNING id`,
          [occurrenceId,schedule.guild_id,schedule.host_discord_user_id,schedule.steam_app_id,schedule.game_name,startsAt,schedule.host_note,schedule.min_players,schedule.max_players,schedule.requires_all_owners,schedule.id,index],
        );
        if (inserted.rowCount) {
          await this.database.query(
            `INSERT INTO session_rsvps (game_session_id,discord_user_id,response,responded_at)
             SELECT $1,discord_user_id,CASE WHEN discord_user_id=$2 THEN 'accepted' ELSE 'pending' END,CASE WHEN discord_user_id=$2 THEN now() ELSE NULL END
             FROM regular_game_night_members WHERE regular_game_night_id=$3`, [occurrenceId,schedule.host_discord_user_id,schedule.id],
          );
          const firstGameId = newId();
          await this.database.query(
            `INSERT INTO game_night_games (id,game_session_id,position,steam_app_id,game_name)
             VALUES ($1,$2,0,$3,$4)`, [firstGameId,occurrenceId,schedule.steam_app_id,schedule.game_name],
          );
          await this.database.query(
            `INSERT INTO game_night_game_players (game_night_game_id,discord_user_id)
             SELECT $1,discord_user_id FROM regular_game_night_members WHERE regular_game_night_id=$2`, [firstGameId,schedule.id],
          );
        }
        index += 1;
        startsAt = new Date(schedule.starts_at);
        startsAt.setUTCDate(startsAt.getUTCDate() + index * schedule.cadence_weeks * 7);
      }
    }
  }

  async listRegularGameNightsReadyForFeed({ horizonDays = 14 } = {}) {
    const rows = await this.database.query(
      `SELECT s.id,s.host_discord_user_id,p.default_lfg_channel_id
       FROM game_sessions s
       JOIN guild_policies p ON p.guild_id=s.guild_id
       LEFT JOIN session_lfg_posts post ON post.game_session_id=s.id
       WHERE s.regular_game_night_id IS NOT NULL AND s.cancelled_at IS NULL AND s.completed_at IS NULL
         AND s.starts_at > now() AND s.starts_at <= now() + ($1 * interval '1 day')
         AND p.default_lfg_channel_id IS NOT NULL AND post.game_session_id IS NULL
       ORDER BY s.starts_at ASC`, [horizonDays],
    );
    return rows.rows;
  }

  async updateSession({ id, hostDiscordUserId, startsAt, hostNote }) {
    const date = new Date(startsAt);
    if (Number.isNaN(date.getTime()) || date <= new Date()) throw new Error('Choose a future start time.');
    if (typeof hostNote !== 'string' || hostNote.length > 500) throw new Error('Host note must be at most 500 characters.');
    const updated = await this.database.query(
      `UPDATE game_sessions SET starts_at = $3, host_note = $4, updated_at = now()
       WHERE id = $1 AND host_discord_user_id = $2 RETURNING id`,
      [id, hostDiscordUserId, date, hostNote.trim() || null],
    );
    if (!updated.rowCount) throw new Error('Only the session host can edit this session.');
    return this.getSession(id, hostDiscordUserId);
  }

  async listGamesTonight(id, discordUserId) {
    const session = await this.getSession(id, discordUserId);
    if (!session) return null;
    const games = await this.database.query(
      `SELECT g.id,g.steam_app_id,g.game_name,g.note,g.status,g.position,
              coalesce(array_agg(p.discord_user_id) FILTER (WHERE p.discord_user_id IS NOT NULL), '{}') AS player_ids
       FROM game_night_games g
       LEFT JOIN game_night_game_players p ON p.game_night_game_id=g.id
       WHERE g.game_session_id=$1
       GROUP BY g.id
       ORDER BY g.position`, [id],
    );
    return Promise.all(games.rows.map(async (game) => {
      const playerIds = game.player_ids ?? [];
      let compatibility = { playerCount: playerIds.length, fitsParty: null, playerCountFits: null, ownershipFits: null, unavailable: [] };
      if (playerIds.length) {
        try {
          const state = await this.partyState(session.guildId, session.hostDiscordUserId, playerIds.filter((playerId) => playerId !== session.hostDiscordUserId));
          const candidate = state.games.find((entry) => entry.appId === game.steam_app_id);
          compatibility = {
            playerCount: state.party.length,
            fitsParty: candidate?.fitsParty ?? false,
            playerCountFits: candidate?.playerCountFits ?? false,
            ownershipFits: candidate?.ownershipFits ?? false,
            unavailable: state.unavailable,
          };
        } catch (error) {
          compatibility = { ...compatibility, error: error.message };
        }
      }
      return { id: game.id, appId: game.steam_app_id, title: game.game_name, note: game.note, status: game.status, position: game.position, playerIds, compatibility };
    }));
  }

  async updateGameTonight({ sessionId, gameId, hostDiscordUserId, status, note }) {
    if (!['up_next','now_playing','completed','skipped','replaced'].includes(status)) throw new Error('Choose a valid Game Tonight status.');
    if (typeof note !== 'string' || note.length > 500) throw new Error('Game note must be at most 500 characters.');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query('SELECT 1 FROM game_sessions WHERE id=$1 AND host_discord_user_id=$2', [sessionId,hostDiscordUserId]);
      if (!owned.rowCount) throw new Error('Only the host can change Games Tonight.');
      if (status === 'now_playing') await client.query("UPDATE game_night_games SET status='up_next',updated_at=now() WHERE game_session_id=$1 AND status='now_playing'", [sessionId]);
      const updated = await client.query('UPDATE game_night_games SET status=$3,note=$4,updated_at=now() WHERE id=$1 AND game_session_id=$2 RETURNING id', [gameId,sessionId,status,note.trim() || null]);
      if (!updated.rowCount) throw new Error('That Game Tonight item is not available.');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.listGamesTonight(sessionId, hostDiscordUserId);
  }

  async addGameTonight({ sessionId, hostDiscordUserId, appId, title, note = '', playerIds = null }) {
    if (!Number.isInteger(appId) || appId <= 0 || typeof title !== 'string' || !title.trim()) throw new Error('Choose a valid game.');
    if (typeof note !== 'string' || note.length > 500) throw new Error('Game note must be at most 500 characters.');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const owns = await client.query('SELECT 1 FROM game_sessions WHERE id=$1 AND host_discord_user_id=$2 FOR UPDATE', [sessionId,hostDiscordUserId]);
      if (!owns.rowCount) throw new Error('Only the host can change Games Tonight.');
      const invited = await client.query('SELECT discord_user_id,response FROM session_rsvps WHERE game_session_id=$1', [sessionId]);
      const invitedIds = new Set(invited.rows.map((row) => row.discord_user_id));
      const expected = playerIds == null ? invited.rows.filter((row) => row.response === 'accepted').map((row) => row.discord_user_id) : normaliseParty(hostDiscordUserId, playerIds);
      if (expected.some((playerId) => !invitedIds.has(playerId))) throw new Error('Expected players must be invited to this Game Night.');
      const id = newId();
      const added = await client.query(`INSERT INTO game_night_games (id,game_session_id,position,steam_app_id,game_name,note)
        SELECT $1,$2,coalesce(max(position)+1,0),$3,$4,$5 FROM game_night_games WHERE game_session_id=$2
        RETURNING id`, [id,sessionId,appId,title.trim(),note.trim() || null]);
      if (!added.rowCount) throw new Error('Could not add that Game Tonight item.');
      for (const playerId of expected) await client.query('INSERT INTO game_night_game_players (game_night_game_id,discord_user_id) VALUES ($1,$2)', [id,playerId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.listGamesTonight(sessionId, hostDiscordUserId);
  }

  async setGameTonightPlayers({ sessionId, gameId, hostDiscordUserId, playerIds }) {
    const expected = normaliseParty(hostDiscordUserId, playerIds);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query('SELECT 1 FROM game_sessions WHERE id=$1 AND host_discord_user_id=$2 FOR UPDATE', [sessionId,hostDiscordUserId]);
      if (!owned.rowCount) throw new Error('Only the host can change Games Tonight.');
      const game = await client.query('SELECT 1 FROM game_night_games WHERE id=$1 AND game_session_id=$2', [gameId,sessionId]);
      if (!game.rowCount) throw new Error('That Game Tonight item is not available.');
      const invited = await client.query('SELECT discord_user_id FROM session_rsvps WHERE game_session_id=$1', [sessionId]);
      const invitedIds = new Set(invited.rows.map((row) => row.discord_user_id));
      if (expected.some((playerId) => !invitedIds.has(playerId))) throw new Error('Expected players must be invited to this Game Night.');
      await client.query('DELETE FROM game_night_game_players WHERE game_night_game_id=$1', [gameId]);
      for (const playerId of expected) await client.query('INSERT INTO game_night_game_players (game_night_game_id,discord_user_id) VALUES ($1,$2)', [gameId,playerId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.listGamesTonight(sessionId, hostDiscordUserId);
  }

  async replanOptions({ sessionId, hostDiscordUserId }) {
    const session = await this.getSession(sessionId, hostDiscordUserId);
    if (!session || session.hostDiscordUserId !== hostDiscordUserId) throw new Error('Only the host can replan this Game Night.');
    const audience = (key, label, statuses) => {
      const playerIds = [...new Set([session.hostDiscordUserId, ...session.rsvps.filter((rsvp) => statuses.includes(rsvp.liveStatus)).map((rsvp) => rsvp.discordUserId)])];
      return { key, label, playerIds, people: session.rsvps.filter((rsvp) => playerIds.includes(rsvp.discordUserId)).map((rsvp) => ({ discordUserId: rsvp.discordUserId, displayName: rsvp.displayName, liveStatus: rsvp.liveStatus })) };
    };
    const audiences = [
      audience('here_now', 'People here now', ['here']),
      audience('joining_next', 'People joining next game', ['here', 'joining_next_game']),
    ];
    for (const group of audiences) {
      if (group.playerIds.length < 2) {
        group.alternatives = [];
        group.message = 'Mark someone as here or joining next game to see shared-game alternatives.';
        continue;
      }
      const state = await this.partyState(session.guildId, session.hostDiscordUserId, group.playerIds.filter((id) => id !== session.hostDiscordUserId));
      group.alternatives = state.games.filter((game) => game.fitsParty).map((game) => ({ appId: game.appId, title: game.title, minPlayers: game.minPlayers, maxPlayers: game.maxPlayers, requiresAllOwners: game.requiresAllOwners }));
      group.unavailable = state.unavailable;
      group.message = group.alternatives.length ? null : state.unavailable.length
        ? 'No shared game fits yet. Ask the people listed above to link Steam or sync a visible library, or choose a different group.'
        : 'No configured shared game fits this group. Pick another group or add a server game setting for a game you can all play.';
    }
    const games = await this.listGamesTonight(sessionId, hostDiscordUserId);
    return {
      audiences,
      replaceableGames: games.filter((game) => ['now_playing', 'up_next'].includes(game.status)).map((game) => ({ id: game.id, title: game.title, status: game.status })),
    };
  }

  async replaceGameTonight({ sessionId, gameId, hostDiscordUserId, audience, appId }) {
    if (!['here_now', 'joining_next'].includes(audience)) throw new Error('Choose the people this replacement is for.');
    if (!Number.isInteger(Number(appId)) || Number(appId) <= 0) throw new Error('Choose a viable replacement game.');
    const options = await this.replanOptions({ sessionId, hostDiscordUserId });
    const group = options.audiences.find((entry) => entry.key === audience);
    const replacement = group?.alternatives.find((game) => game.appId === Number(appId));
    if (!replacement) throw new Error('That game is not a viable shared option for the people selected. Refresh the roster and try again.');
    const client = await this.database.connect();
    let replaced;
    try {
      await client.query('BEGIN');
      const original = await client.query(`SELECT g.id,g.game_name,g.status,g.position FROM game_night_games g
        JOIN game_sessions s ON s.id=g.game_session_id WHERE g.id=$1 AND g.game_session_id=$2 AND s.host_discord_user_id=$3 FOR UPDATE`, [gameId, sessionId, hostDiscordUserId]);
      if (!original.rowCount || !['now_playing', 'up_next'].includes(original.rows[0].status)) throw new Error('Choose the current or an Up next game to replace.');
      replaced = original.rows[0];
      await client.query(`UPDATE game_night_games SET status='replaced',position=(SELECT coalesce(max(position),0)+1 FROM game_night_games WHERE game_session_id=$1),updated_at=now() WHERE id=$2`, [sessionId, gameId]);
      const newGameId = newId();
      await client.query(`INSERT INTO game_night_games (id,game_session_id,position,steam_app_id,game_name,status,note)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [newGameId, sessionId, replaced.position, replacement.appId, replacement.title, replaced.status, `Replanned for ${group.label.toLowerCase()}`]);
      for (const playerId of group.playerIds) await client.query('INSERT INTO game_night_game_players (game_night_game_id,discord_user_id) VALUES ($1,$2)', [newGameId, playerId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return { games: await this.listGamesTonight(sessionId, hostDiscordUserId), replaced: { id: replaced.id, title: replaced.game_name, status: replaced.status }, replacement, audience: group };
  }

  async removeGameTonight({ sessionId, gameId, hostDiscordUserId }) {
    const removed = await this.database.query(`DELETE FROM game_night_games g
      USING game_sessions s WHERE g.id=$1 AND g.game_session_id=$2 AND s.id=$2 AND s.host_discord_user_id=$3
      RETURNING g.id`, [gameId,sessionId,hostDiscordUserId]);
    if (!removed.rowCount) throw new Error('Only the host can remove that Game Tonight item.');
    return this.listGamesTonight(sessionId, hostDiscordUserId);
  }

  async reorderGameTonight({ sessionId, gameId, hostDiscordUserId, position }) {
    if (!Number.isInteger(position) || position < 0) throw new Error('Choose a valid Games Tonight position.');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query('SELECT 1 FROM game_sessions WHERE id=$1 AND host_discord_user_id=$2 FOR UPDATE', [sessionId,hostDiscordUserId]);
      if (!owned.rowCount) throw new Error('Only the host can reorder Games Tonight.');
      const rows = (await client.query('SELECT id FROM game_night_games WHERE game_session_id=$1 ORDER BY position FOR UPDATE', [sessionId])).rows;
      const oldIndex = rows.findIndex((row) => row.id === gameId);
      if (oldIndex < 0) throw new Error('That Game Tonight item is not available.');
      const [moving] = rows.splice(oldIndex, 1); rows.splice(Math.min(position, rows.length), 0, moving);
      await client.query('UPDATE game_night_games SET position=position+1000 WHERE game_session_id=$1', [sessionId]);
      for (const [index, row] of rows.entries()) await client.query('UPDATE game_night_games SET position=$2,updated_at=now() WHERE id=$1', [row.id,index]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.listGamesTonight(sessionId, hostDiscordUserId);
  }

  async respondToSession({ id, discordUserId, response }) {
    if (!['accepted', 'declined'].includes(response)) throw new Error('RSVP response must be accepted or declined.');
    const updated = await this.database.query(
      `UPDATE session_rsvps SET response = $3, responded_at = now()
       WHERE game_session_id = $1 AND discord_user_id = $2 RETURNING game_session_id`,
      [id, discordUserId, response],
    );
    if (!updated.rowCount) throw new Error('You are not invited to this session.');
    return this.getSession(id, discordUserId);
  }

  async updateLiveStatus({ id, actorDiscordUserId, discordUserId = actorDiscordUserId, status }) {
    if (!['coming','running_late','here','leaving','joining_next_game'].includes(status)) throw new Error('Choose a valid Game Night status.');
    const session = await this.database.query('SELECT host_discord_user_id FROM game_sessions WHERE id=$1 AND cancelled_at IS NULL', [id]);
    if (!session.rowCount) throw new Error('This Game Night is not available.');
    if (actorDiscordUserId !== discordUserId && session.rows[0].host_discord_user_id !== actorDiscordUserId) throw new Error('Only the host can update someone else’s status.');
    const invited = await this.database.query('SELECT 1 FROM session_rsvps WHERE game_session_id=$1 AND discord_user_id=$2', [id, discordUserId]);
    if (!invited.rowCount) throw new Error('That person is not part of this Game Night.');
    await this.database.query(`INSERT INTO session_live_statuses (game_session_id,discord_user_id,status,updated_by_discord_user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (game_session_id,discord_user_id) DO UPDATE SET status=EXCLUDED.status,updated_by_discord_user_id=EXCLUDED.updated_by_discord_user_id,updated_at=now()`, [id,discordUserId,status,actorDiscordUserId]);
    await this.database.query('INSERT INTO session_live_status_events (id,game_session_id,discord_user_id,status,updated_by_discord_user_id) VALUES ($1,$2,$3,$4,$5)', [newId(),id,discordUserId,status,actorDiscordUserId]);
    return this.getSession(id, actorDiscordUserId);
  }

  async joinLfg({ id, guildId, discordUserId }) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const session = await client.query('SELECT guild_id, steam_app_id, max_players, requires_all_owners, registration_closed_at, completed_at FROM game_sessions WHERE id=$1 AND guild_id=$2 AND cancelled_at IS NULL FOR UPDATE', [id, guildId]);
      if (!session.rowCount) throw new Error('This session is not in this Discord server.');
      if (session.rows[0].registration_closed_at || session.rows[0].completed_at) throw new Error('This session is already underway or complete, so new joins are closed.');
      if (session.rows[0].requires_all_owners ?? true) {
        const owns = await client.query(`SELECT 1 FROM steam_connections c JOIN steam_owned_games g ON g.discord_user_id=c.discord_user_id WHERE c.discord_user_id=$1 AND c.last_sync_status='complete' AND g.app_id=$2`, [discordUserId, session.rows[0].steam_app_id]);
        if (!owns.rowCount) throw new Error('Link Steam and sync a visible library that owns this game before joining.');
      }
      const maxPlayers = session.rows[0].max_players ?? gamePolicy(session.rows[0].steam_app_id, 'this game').maxPlayers;
      const count = await client.query(`SELECT count(*)::int AS count FROM session_rsvps WHERE game_session_id=$1 AND response='accepted'`, [id]);
      const mine = await client.query('SELECT response FROM session_rsvps WHERE game_session_id=$1 AND discord_user_id=$2', [id, discordUserId]);
      if ((!mine.rowCount || mine.rows[0].response !== 'accepted') && maxPlayers && count.rows[0].count >= maxPlayers) throw new Error('This session is full.');
      await client.query(`INSERT INTO session_rsvps (game_session_id,discord_user_id,response,responded_at) VALUES ($1,$2,'accepted',now()) ON CONFLICT (game_session_id,discord_user_id) DO UPDATE SET response='accepted',responded_at=now()`, [id, discordUserId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    return this.getSession(id, discordUserId);
  }

  async closeStartedSessions() {
    return (await this.database.query(`UPDATE game_sessions SET registration_closed_at=now(),updated_at=now() WHERE cancelled_at IS NULL AND completed_at IS NULL AND registration_closed_at IS NULL AND starts_at <= now() RETURNING id,host_discord_user_id`)).rows;
  }

  async completeSession({ id, guildId, hostDiscordUserId }) {
    const completed = await this.database.query(`UPDATE game_sessions SET completed_at=now(),registration_closed_at=coalesce(registration_closed_at,now()),updated_at=now() WHERE id=$1 AND guild_id=$2 AND host_discord_user_id=$3 AND cancelled_at IS NULL AND completed_at IS NULL RETURNING id`, [id, guildId, hostDiscordUserId]);
    if (!completed.rowCount) throw new Error('Only the host can complete an active session.');
  }

  async leaveLfg({ id, guildId, discordUserId }) {
    const session = await this.database.query('SELECT host_discord_user_id FROM game_sessions WHERE id=$1 AND guild_id=$2 AND cancelled_at IS NULL', [id, guildId]);
    if (!session.rowCount) throw new Error('This session is not available.');
    if (session.rows[0].host_discord_user_id === discordUserId) throw new Error('Transfer Host to a confirmed player before leaving, or cancel the session explicitly.');
    const left = await this.database.query(`UPDATE session_rsvps SET response='declined', responded_at=now() WHERE game_session_id=$1 AND discord_user_id=$2 AND response='accepted' RETURNING game_session_id`, [id, discordUserId]);
    if (!left.rowCount) throw new Error('You have not joined this session.');
    const remaining = await this.database.query(`SELECT count(*)::int AS count FROM session_rsvps WHERE game_session_id=$1 AND response='accepted'`, [id]);
    if (remaining.rows[0].count === 0) { await this.database.query('UPDATE game_sessions SET cancelled_at=now(), cancelled_by_discord_user_id=$2 WHERE id=$1', [id, discordUserId]); return { cancelled: true }; }
    return this.getSession(id, discordUserId);
  }

  async cancelSession({ id, guildId, hostDiscordUserId, cancellationReason = '' }) {
    if (typeof cancellationReason !== 'string' || cancellationReason.length > 500) throw new Error('Cancellation reason must be at most 500 characters.');
    const cancelled = await this.database.query(
      'UPDATE game_sessions SET cancelled_at=now(), cancelled_by_discord_user_id=$3, cancellation_reason=$4 WHERE id=$1 AND guild_id=$2 AND host_discord_user_id=$3 AND cancelled_at IS NULL RETURNING id, cancellation_reason',
      [id, guildId, hostDiscordUserId, cancellationReason.trim() || null],
    );
    if (!cancelled.rowCount) throw new Error('Only the host can cancel this session.');
    return { cancelled: true, cancellationReason: cancelled.rows[0].cancellation_reason };
  }

  async saveGuildGameRule({ guildId, steamAppId, gameName, minPlayers, maxPlayers, requiresAllOwners, configuredByDiscordUserId }) {
    if (!guildId || !Number.isInteger(steamAppId) || steamAppId <= 0) throw new Error('Choose a valid Steam game.');
    if (!Number.isInteger(minPlayers) || !Number.isInteger(maxPlayers) || minPlayers < 1 || maxPlayers < minPlayers || maxPlayers > 100) throw new Error('Set a minimum and maximum between 1 and 100 players.');
    if (typeof requiresAllOwners !== 'boolean') throw new Error('Choose whether everyone needs to own this game.');
    const saved = await this.database.query(
      `INSERT INTO guild_game_rules (guild_id,steam_app_id,game_name,min_players,max_players,requires_all_owners,configured_by_discord_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (guild_id,steam_app_id) DO UPDATE SET game_name=coalesce(EXCLUDED.game_name,guild_game_rules.game_name),min_players=EXCLUDED.min_players,max_players=EXCLUDED.max_players,requires_all_owners=EXCLUDED.requires_all_owners,configured_by_discord_user_id=EXCLUDED.configured_by_discord_user_id,updated_at=now()
       RETURNING steam_app_id,game_name,min_players,max_players,requires_all_owners`,
      [guildId, steamAppId, gameName ?? null, minPlayers, maxPlayers, requiresAllOwners, configuredByDiscordUserId],
    );
    await this.database.query(`INSERT INTO guild_game_rule_revisions (id,guild_id,steam_app_id,game_name,min_players,max_players,requires_all_owners,changed_by_discord_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId(), guildId, steamAppId, saved.rows[0].game_name ?? gameName ?? `Steam app ${steamAppId}`, minPlayers, maxPlayers, requiresAllOwners, configuredByDiscordUserId]);
    return { appId: saved.rows[0].steam_app_id, name: saved.rows[0].game_name, minPlayers: saved.rows[0].min_players, maxPlayers: saved.rows[0].max_players, requiresAllOwners: saved.rows[0].requires_all_owners };
  }

  async listGuildGameSettings(guildId) {
    if (!guildId) throw new Error('Open GamePlan from a Discord server to manage game settings.');
    const settings = await this.database.query(
      `WITH discovered_games AS (
         SELECT games.app_id, min(games.name) AS store_title, count(DISTINCT games.discord_user_id)::int AS owner_count
         FROM steam_owned_games games
         JOIN guild_members members ON members.discord_user_id=games.discord_user_id AND members.guild_id=$1
         JOIN steam_connections connections ON connections.discord_user_id=games.discord_user_id AND connections.last_sync_status='complete'
         GROUP BY games.app_id
       )
       SELECT coalesce(discovered_games.app_id,rules.steam_app_id) AS app_id,
              coalesce(discovered_games.store_title,rules.game_name,concat('Steam app ',rules.steam_app_id)) AS store_title,
              coalesce(discovered_games.owner_count,0)::int AS owner_count,
              rules.min_players,rules.max_players,rules.requires_all_owners,
              metadata.min_players AS external_min_players, metadata.max_players AS external_max_players
       FROM discovered_games
       FULL OUTER JOIN guild_game_rules rules ON rules.guild_id=$1 AND rules.steam_app_id=discovered_games.app_id
       LEFT JOIN external_games metadata ON metadata.steam_app_id = coalesce(discovered_games.app_id,rules.steam_app_id)
       ORDER BY lower(coalesce(discovered_games.store_title,rules.game_name,'')), coalesce(discovered_games.app_id,rules.steam_app_id)`,
      [guildId],
    );
    return settings.rows.map(serialiseGameSetting);
  }

  async listGuildGameRules(guildId) { return (await this.database.query(`SELECT r.steam_app_id,r.game_name,r.min_players,r.max_players,r.requires_all_owners,r.updated_at,u.display_name AS changed_by FROM guild_game_rules r LEFT JOIN discord_users u ON u.discord_user_id=r.configured_by_discord_user_id WHERE r.guild_id=$1 ORDER BY lower(coalesce(r.game_name,'')),r.steam_app_id`, [guildId])).rows; }

  async transferHost({ id, guildId, hostDiscordUserId, newHostDiscordUserId }) {
    const transferred = await this.database.query(
      `UPDATE game_sessions s SET host_discord_user_id=$4, updated_at=now()
       WHERE s.id=$1 AND s.guild_id=$2 AND s.host_discord_user_id=$3 AND s.cancelled_at IS NULL
         AND EXISTS (SELECT 1 FROM session_rsvps r WHERE r.game_session_id=s.id AND r.discord_user_id=$4 AND r.response='accepted')
       RETURNING id`, [id, guildId, hostDiscordUserId, newHostDiscordUserId],
    );
    if (!transferred.rowCount) throw new Error('Choose a confirmed participant to receive Host, or cancel the session.');
    return this.getSession(id, newHostDiscordUserId);
  }
}

import { newId } from './tokens.mjs';
import { gamePolicy } from './game-policy.mjs';

const MAX_ROSTER = 100;
const VOICE_FRESHNESS_MS = 5 * 60 * 1000;

function ids(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && /^\d{5,25}$/.test(id)))];
}

function parseIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try { return parseIds(JSON.parse(value)); } catch { return []; }
  }
  return [];
}

function integer(value) {
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
}

function configuredPolicy(row) {
  const catalog = gamePolicy(row.app_id, row.game_name);
  const minPlayers = row.min_players ?? catalog.minPlayers ?? row.external_min_players;
  const maxPlayers = row.max_players ?? catalog.maxPlayers ?? row.external_max_players;
  if (minPlayers == null || maxPlayers == null) return null;
  const ruleSource = row.min_players != null && row.max_players != null ? 'guild' : catalog.minPlayers != null && catalog.maxPlayers != null ? 'catalog' : 'external';
  return {
    appId: row.app_id,
    title: row.game_name,
    minPlayers,
    maxPlayers,
    requiresAllOwners: row.requires_all_owners,
    policyNote: ruleSource === 'guild' ? 'Player count configured by this Discord server.' : ruleSource === 'external' ? 'Player-count default inferred from IGDB metadata.' : catalog.policyNote,
    ruleSource,
    catalog,
  };
}

function preferenceScore(rank) { return 4 - rank; }

export class RallyService {
  constructor({ database, planner, now = () => new Date() }) {
    this.database = database;
    this.planner = planner;
    this.now = now;
  }

  async create({ guildId, hostDiscordUserId, startsAt, voiceChannelId = null, rosterSource = 'manual' }) {
    if (!guildId) throw new Error('Run GamePlan in a Discord server.');
    if (!['manual', 'voice'].includes(rosterSource)) throw new Error('Choose a manual or voice-channel roster.');
    const starts = new Date(startsAt);
    if (Number.isNaN(starts.getTime())) throw new Error('Choose a valid game-vote start time.');
    if (starts.getTime() < this.now().getTime() - 60_000) throw new Error('A game vote cannot start in the past.');
    const id = newId();
    const expiresAt = new Date(Math.max(starts.getTime(), this.now().getTime()) + 8 * 60 * 60 * 1000);
    await this.database.query(
      `INSERT INTO rallies (id,guild_id,host_discord_user_id,starts_at,voice_channel_id,roster_source,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, guildId, hostDiscordUserId, starts, voiceChannelId, rosterSource, expiresAt],
    );
    await this.database.query(
      `INSERT INTO rally_members (rally_id,discord_user_id,status,source)
       VALUES ($1,$2,'in','manual')`,
      [id, hostDiscordUserId],
    );
    return this.get(id, hostDiscordUserId);
  }

  async get(id, viewerDiscordUserId = null) {
    const rally = await this.database.query(
      `SELECT r.*, u.display_name AS host_display_name, snapshot.participant_ids, snapshot.captured_at, snapshot.gateway_observed_at
       FROM rallies r JOIN discord_users u ON u.discord_user_id=r.host_discord_user_id
       LEFT JOIN rally_roster_snapshots snapshot ON snapshot.rally_id=r.id
       WHERE r.id=$1`, [id],
    );
    if (!rally.rowCount) return null;
    const row = rally.rows[0];
    const [members, votes, candidates] = await Promise.all([
      this.database.query(`SELECT m.discord_user_id,m.status,m.source,m.updated_at,u.display_name,c.last_sync_status
        FROM rally_members m JOIN discord_users u ON u.discord_user_id=m.discord_user_id
        LEFT JOIN steam_connections c ON c.discord_user_id=m.discord_user_id
        WHERE m.rally_id=$1 ORDER BY lower(coalesce(u.display_name,u.discord_user_id))`, [id]),
      this.database.query('SELECT discord_user_id,steam_app_id,rank FROM rally_votes WHERE rally_id=$1 ORDER BY discord_user_id,rank', [id]),
      this.database.query('SELECT * FROM rally_candidates WHERE rally_id=$1 ORDER BY potential_participants DESC,lower(game_name),steam_app_id', [id]),
    ]);
    const rosterIds = parseIds(row.participant_ids);
    const voteMap = new Map();
    for (const vote of votes.rows) {
      const existing = voteMap.get(vote.discord_user_id) ?? [];
      existing.push({ appId: vote.steam_app_id, rank: vote.rank });
      voteMap.set(vote.discord_user_id, existing);
    }
    return {
      id: row.id,
      guildId: row.guild_id,
      hostDiscordUserId: row.host_discord_user_id,
      hostDisplayName: row.host_display_name ?? row.host_discord_user_id,
      startsAt: row.starts_at,
      voiceChannelId: row.voice_channel_id,
      rosterSource: row.roster_source,
      state: row.state,
      rosterLockedAt: row.roster_locked_at,
      pollOpenedAt: row.poll_opened_at,
      lockedGameSessionId: row.locked_game_session_id,
      cancellationReason: row.cancellation_reason,
      expiresAt: row.expires_at,
      rosterSnapshot: rosterIds.length ? { participantIds: rosterIds, capturedAt: row.captured_at, gatewayObservedAt: row.gateway_observed_at } : null,
      members: members.rows.map((member) => ({
        discordUserId: member.discord_user_id,
        displayName: member.display_name ?? member.discord_user_id,
        status: member.status,
        source: member.source,
        steamReady: member.last_sync_status === 'complete',
      })),
      candidates: candidates.rows.map((candidate) => ({
        appId: candidate.steam_app_id,
        title: candidate.game_name,
        minPlayers: candidate.min_players,
        maxPlayers: candidate.max_players,
        requiresAllOwners: candidate.requires_all_owners,
        viableParticipantIds: parseIds(candidate.viable_participant_ids),
        potentialParticipants: candidate.potential_participants,
      })),
      votes: [...voteMap.entries()].map(([discordUserId, rankings]) => ({ discordUserId, rankings })),
      viewerRankings: viewerDiscordUserId ? voteMap.get(viewerDiscordUserId) ?? [] : [],
    };
  }

  async setMember({ rallyId, discordUserId, status }) {
    if (!['in', 'out'].includes(status)) throw new Error('Game-vote attendance must be in or out.');
    const rally = await this.requireMutable(rallyId);
    await this.database.query(
      `INSERT INTO rally_members (rally_id,discord_user_id,status,source)
       VALUES ($1,$2,$3,'manual')
       ON CONFLICT (rally_id,discord_user_id) DO UPDATE SET status=EXCLUDED.status,source='manual',updated_at=now()`,
      [rallyId, discordUserId, status],
    );
    return this.get(rally.id, discordUserId);
  }

  async refreshVoiceRoster({ rallyId, hostDiscordUserId }) {
    const rally = await this.requireMutable(rallyId);
    if (rally.host_discord_user_id !== hostDiscordUserId) throw new Error('Only the game-vote host can refresh its voice roster.');
    if (rally.roster_source !== 'voice' || !rally.voice_channel_id) throw new Error('This game vote does not use a voice-channel roster.');
    const observed = await this.database.query(
      `SELECT discord_user_id,observed_at FROM voice_channel_members
       WHERE guild_id=$1 AND channel_id=$2 ORDER BY observed_at DESC`, [rally.guild_id, rally.voice_channel_id],
    );
    const newest = observed.rows[0]?.observed_at ? new Date(observed.rows[0].observed_at) : null;
    if (!newest || this.now().getTime() - newest.getTime() > VOICE_FRESHNESS_MS) {
      throw new Error('GamePlan has no fresh voice-channel roster yet. Wait a moment, then try Refresh voice roster again.');
    }
    const participantIds = ids(observed.rows.map((member) => member.discord_user_id));
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE rally_members SET status='out',updated_at=now() WHERE rally_id=$1 AND source='voice'", [rallyId]);
      for (const discordUserId of participantIds) {
        await client.query(
          `INSERT INTO rally_members (rally_id,discord_user_id,status,source) VALUES ($1,$2,'in','voice')
           ON CONFLICT (rally_id,discord_user_id) DO UPDATE SET status='in',source='voice',updated_at=now()`,
          [rallyId, discordUserId],
        );
      }
      await client.query('UPDATE rallies SET updated_at=now() WHERE id=$1', [rallyId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return this.get(rallyId, hostDiscordUserId);
  }

  async openPoll({ rallyId, hostDiscordUserId }) {
    const rally = await this.requireMutable(rallyId);
    if (rally.host_discord_user_id !== hostDiscordUserId) throw new Error('Only the game-vote host can start the game vote.');
    const members = await this.database.query("SELECT discord_user_id FROM rally_members WHERE rally_id=$1 AND status='in' ORDER BY discord_user_id", [rallyId]);
    const participantIds = ids(members.rows.map((member) => member.discord_user_id));
    if (participantIds.length < 1) throw new Error('Add at least one attendee before opening the poll.');
    if (participantIds.length > MAX_ROSTER) throw new Error(`A game vote supports at most ${MAX_ROSTER} attendees.`);
    const snapshot = await this.buildCandidates({ guildId: rally.guild_id, participantIds });
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`UPDATE rallies SET state='polling',roster_locked_at=now(),poll_opened_at=now(),updated_at=now()
        WHERE id=$1 AND state='open' RETURNING id`, [rallyId]);
      if (!locked.rowCount) throw new Error('This game vote is no longer open for a new poll.');
      await client.query(`INSERT INTO rally_roster_snapshots (id,rally_id,voice_channel_id,gateway_observed_at,participant_ids)
        VALUES ($1,$2,$3,$4,$5)`, [newId(), rallyId, rally.voice_channel_id, snapshot.gatewayObservedAt, JSON.stringify(participantIds)]);
      for (const candidate of snapshot.candidates) {
        await client.query(`INSERT INTO rally_candidates
          (rally_id,steam_app_id,game_name,min_players,max_players,requires_all_owners,viable_participant_ids,potential_participants)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [rallyId, candidate.appId, candidate.title, candidate.minPlayers, candidate.maxPlayers, candidate.requiresAllOwners, JSON.stringify(candidate.viableParticipantIds), candidate.potentialParticipants]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return { rally: await this.get(rallyId, hostDiscordUserId), unconfiguredGames: snapshot.unconfiguredGames };
  }

  async castVote({ rallyId, discordUserId, appIds }) {
    const choices = [...new Set((appIds ?? []).map(integer).filter((appId) => appId && appId > 0))].slice(0, 3);
    const rally = await this.database.query('SELECT state FROM rallies WHERE id=$1', [rallyId]);
    if (!rally.rowCount || rally.rows[0].state !== 'polling') throw new Error('This game vote is not accepting rankings.');
    const snapshot = await this.database.query('SELECT participant_ids FROM rally_roster_snapshots WHERE rally_id=$1', [rallyId]);
    if (!snapshot.rowCount || !parseIds(snapshot.rows[0].participant_ids).includes(discordUserId)) throw new Error('Only someone in the frozen game-vote roster can rank games.');
    const candidates = await this.database.query('SELECT steam_app_id FROM rally_candidates WHERE rally_id=$1 AND steam_app_id=ANY($2::int[])', [rallyId, choices]);
    if (candidates.rowCount !== choices.length) throw new Error('Choose only games in this game vote’s candidate list.');
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM rally_votes WHERE rally_id=$1 AND discord_user_id=$2', [rallyId, discordUserId]);
      for (const [index, appId] of choices.entries()) await client.query(
        'INSERT INTO rally_votes (rally_id,discord_user_id,steam_app_id,rank) VALUES ($1,$2,$3,$4)', [rallyId, discordUserId, appId, index + 1],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    return this.get(rallyId, discordUserId);
  }

  async result(rallyId) {
    const rally = await this.get(rallyId);
    if (!rally || !['polling', 'locked'].includes(rally.state)) throw new Error('Open the game-choice poll before viewing its result.');
    const scores = new Map(rally.candidates.map((candidate) => [candidate.appId, { candidate, preferencePoints: 0, firstChoices: 0 }]));
    for (const vote of rally.votes) for (const ranking of vote.rankings) {
      const score = scores.get(ranking.appId);
      if (score) {
        score.preferencePoints += preferenceScore(ranking.rank);
        if (ranking.rank === 1) score.firstChoices += 1;
      }
    }
    const ranked = [...scores.values()].sort((a, b) =>
      b.candidate.potentialParticipants - a.candidate.potentialParticipants ||
      b.preferencePoints - a.preferencePoints || b.firstChoices - a.firstChoices ||
      a.candidate.title.localeCompare(b.candidate.title) || a.candidate.appId - b.candidate.appId,
    );
    const winner = ranked[0] ?? null;
    const tied = winner ? ranked.filter((entry) => entry.candidate.potentialParticipants === winner.candidate.potentialParticipants && entry.preferencePoints === winner.preferencePoints && entry.firstChoices === winner.firstChoices) : [];
    return {
      ranked: ranked.map((entry) => ({ ...entry.candidate, preferencePoints: entry.preferencePoints, firstChoices: entry.firstChoices })),
      recommendedAppId: tied.length === 1 ? winner.candidate.appId : null,
      tiedAppIds: tied.map((entry) => entry.candidate.appId),
    };
  }

  async lock({ rallyId, hostDiscordUserId, appId, hostNote = '' }) {
    const claimed = await this.database.query(`UPDATE rallies SET state='locking',updated_at=now()
      WHERE id=$1 AND host_discord_user_id=$2 AND state='polling' RETURNING *`, [rallyId, hostDiscordUserId]);
    if (!claimed.rowCount) throw new Error('Only the game-vote host can choose an available game.');
    const rally = claimed.rows[0];
    const candidate = await this.database.query('SELECT * FROM rally_candidates WHERE rally_id=$1 AND steam_app_id=$2', [rallyId, appId]);
    try {
      if (!candidate.rowCount) throw new Error('Choose a game from this game vote’s candidates.');
      const planned = parseIds(candidate.rows[0].viable_participant_ids).slice(0, candidate.rows[0].max_players);
      if (!planned.includes(hostDiscordUserId)) throw new Error('The game-vote host must be eligible to play the selected game before choosing it. Transfer the game vote to an eligible player or choose another game.');
      const session = await this.planner.createSession({
        guildId: rally.guild_id,
        hostDiscordUserId,
        party: planned.filter((id) => id !== hostDiscordUserId),
        appId: Number(appId),
        startsAt: rally.starts_at,
        hostNote,
        allowImmediate: true,
        acceptAll: true,
      });
      await this.database.query(`UPDATE rallies SET state='locked',locked_game_session_id=$2,updated_at=now()
        WHERE id=$1 AND state='locking'`, [rallyId, session.id]);
      return { rally: await this.get(rallyId, hostDiscordUserId), session };
    } catch (error) {
      await this.database.query("UPDATE rallies SET state='polling',updated_at=now() WHERE id=$1 AND state='locking'", [rallyId]);
      throw error;
    }
  }

  async cancel({ rallyId, hostDiscordUserId, reason = '' }) {
    if (typeof reason !== 'string' || reason.length > 500) throw new Error('A cancellation reason must be at most 500 characters.');
    const result = await this.database.query(`UPDATE rallies SET state='cancelled',cancellation_reason=$3,updated_at=now()
      WHERE id=$1 AND host_discord_user_id=$2 AND state IN ('open','polling') RETURNING id`, [rallyId, hostDiscordUserId, reason.trim() || null]);
    if (!result.rowCount) throw new Error('Only the host can cancel an open game vote.');
    return this.get(rallyId, hostDiscordUserId);
  }

  async expireRallies() {
    return (await this.database.query(`UPDATE rallies SET state='expired',updated_at=now()
      WHERE state IN ('open','polling') AND expires_at <= now() RETURNING id,host_discord_user_id`)).rows;
  }

  async requireMutable(rallyId, expectedState = 'open') {
    const rally = await this.database.query('SELECT * FROM rallies WHERE id=$1 AND state=$2', [rallyId, expectedState]);
    if (!rally.rowCount) throw new Error(expectedState === 'open' ? 'This game vote is no longer open.' : 'This game vote is not ready for that action.');
    return rally.rows[0];
  }

  async buildCandidates({ guildId, participantIds }) {
    const members = await this.database.query(
      `SELECT gm.discord_user_id,c.last_sync_status FROM guild_members gm
       LEFT JOIN steam_connections c ON c.discord_user_id=gm.discord_user_id
       WHERE gm.guild_id=$1 AND gm.discord_user_id=ANY($2::text[])`, [guildId, participantIds],
    );
    const readyIds = members.rows.filter((member) => member.last_sync_status === 'complete').map((member) => member.discord_user_id);
    const games = readyIds.length ? await this.database.query(
      `SELECT games.app_id,min(games.name) AS game_name,array_agg(DISTINCT games.discord_user_id) AS owner_ids,
              rules.min_players,rules.max_players,rules.requires_all_owners,
              metadata.min_players AS external_min_players,metadata.max_players AS external_max_players
       FROM steam_owned_games games
       JOIN steam_connections connections ON connections.discord_user_id=games.discord_user_id AND connections.last_sync_status='complete'
       LEFT JOIN guild_game_rules rules ON rules.guild_id=$2 AND rules.steam_app_id=games.app_id
       LEFT JOIN external_games metadata ON metadata.steam_app_id=games.app_id
       WHERE games.discord_user_id=ANY($1::text[])
       GROUP BY games.app_id,rules.min_players,rules.max_players,rules.requires_all_owners,metadata.min_players,metadata.max_players
       ORDER BY min(games.name)`, [readyIds, guildId],
    ) : { rows: [] };
    const candidates = [];
    const unconfiguredGames = [];
    for (const row of games.rows) {
      const policy = configuredPolicy(row);
      if (!policy) { unconfiguredGames.push({ appId: row.app_id, title: row.game_name }); continue; }
      const ownerIds = new Set(parseIds(row.owner_ids));
      const viableParticipantIds = policy.requiresAllOwners
        ? participantIds.filter((id) => ownerIds.has(id))
        : participantIds;
      const potentialParticipants = Math.min(policy.maxPlayers, viableParticipantIds.length);
      if (potentialParticipants < policy.minPlayers) continue;
      candidates.push({ ...policy, viableParticipantIds, potentialParticipants });
    }
    const voiceObserved = await this.database.query(`SELECT max(observed_at) AS observed_at FROM voice_channel_members WHERE guild_id=$1 AND discord_user_id=ANY($2::text[])`, [guildId, participantIds]);
    return { candidates, unconfiguredGames, gatewayObservedAt: voiceObserved.rows[0]?.observed_at ?? null };
  }
}

export const rallyConstants = { MAX_ROSTER, VOICE_FRESHNESS_MS };

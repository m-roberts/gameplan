-- Current GamePlan schema baseline for fresh installations.
-- Generated from migrations 0001 through 0020; keep it in lock-step with test/migration-baseline.test.mjs.

-- Source: 0001_foundation.sql
CREATE TABLE discord_users (
  discord_user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guild_installations (
  guild_id TEXT PRIMARY KEY,
  installed_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE browser_link_tickets (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  guild_id TEXT REFERENCES guild_installations(guild_id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE browser_sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token_hash TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE steam_connections (
  discord_user_id TEXT PRIMARY KEY REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL UNIQUE,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ,
  last_sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (last_sync_status IN ('pending', 'complete', 'unavailable', 'error')),
  last_sync_error TEXT
);

CREATE TABLE steam_link_attempts (
  id UUID PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ownership_snapshots (
  id UUID PRIMARY KEY,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  steam_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('complete', 'unavailable', 'error')),
  game_count INTEGER,
  error_message TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE steam_owned_games (
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  playtime_minutes INTEGER NOT NULL DEFAULT 0,
  snapshot_id UUID NOT NULL REFERENCES ownership_snapshots(id) ON DELETE CASCADE,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, app_id)
);

CREATE TABLE game_sessions (
  id UUID PRIMARY KEY,
  guild_id TEXT REFERENCES guild_installations(guild_id) ON DELETE SET NULL,
  host_discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE RESTRICT,
  steam_app_id INTEGER NOT NULL,
  game_name TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  host_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_rsvps (
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  response TEXT NOT NULL CHECK (response IN ('pending', 'accepted', 'declined')),
  responded_at TIMESTAMPTZ,
  PRIMARY KEY (game_session_id, discord_user_id)
);

CREATE INDEX browser_link_tickets_active_idx ON browser_link_tickets (token_hash, expires_at) WHERE redeemed_at IS NULL;
CREATE INDEX browser_sessions_active_idx ON browser_sessions (token_hash, expires_at) WHERE revoked_at IS NULL;
CREATE INDEX ownership_snapshots_user_idx ON ownership_snapshots (discord_user_id, completed_at DESC);
CREATE INDEX steam_owned_games_app_idx ON steam_owned_games (app_id);

-- Source: 0002_planner.sql
ALTER TABLE browser_sessions ADD COLUMN guild_id TEXT REFERENCES guild_installations(guild_id) ON DELETE SET NULL;

CREATE TABLE guild_members (
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id)
);

CREATE INDEX guild_members_user_idx ON guild_members (discord_user_id);
CREATE INDEX session_rsvps_user_idx ON session_rsvps (discord_user_id);
CREATE INDEX game_sessions_guild_starts_idx ON game_sessions (guild_id, starts_at);

-- Source: 0003_discord_workflows.sql
CREATE TABLE session_lfg_posts (
  game_session_id UUID PRIMARY KEY REFERENCES game_sessions(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  discussion_thread_id TEXT,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session_dm_invites (
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_session_id, discord_user_id)
);

-- Source: 0004_guild_policy.sql
CREATE TABLE guild_policies (
  guild_id TEXT PRIMARY KEY REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  default_lfg_channel_id TEXT,
  updated_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guild_policy_channels (
  guild_id TEXT NOT NULL REFERENCES guild_policies(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE guild_policy_coordinator_roles (
  guild_id TEXT NOT NULL REFERENCES guild_policies(guild_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

ALTER TABLE browser_link_tickets ADD COLUMN guild_permissions TEXT;
ALTER TABLE browser_link_tickets ADD COLUMN guild_role_ids JSONB;
ALTER TABLE browser_sessions ADD COLUMN guild_permissions TEXT;
ALTER TABLE browser_sessions ADD COLUMN guild_role_ids JSONB;

-- Source: 0005_discord_flow_states.sql
CREATE TABLE discord_flow_states (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX discord_flow_states_active_idx
  ON discord_flow_states (id, discord_user_id, kind, expires_at);

-- Source: 0006_session_lifecycle.sql
ALTER TABLE game_sessions ADD COLUMN cancelled_at TIMESTAMPTZ;
ALTER TABLE game_sessions ADD COLUMN cancelled_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL;

-- Source: 0007_notifications.sql
CREATE TABLE discord_user_notification_settings (
  discord_user_id TEXT PRIMARY KEY REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  quiet_start TIME,
  quiet_end TIME,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL)),
  CHECK (quiet_start IS NULL OR quiet_start <> quiet_end)
);

CREATE TABLE guild_notification_preferences (
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  reminder_delivery TEXT NOT NULL DEFAULT 'off' CHECK (reminder_delivery IN ('off', 'dm', 'thread', 'both')),
  reminder_lead_minutes INTEGER[] NOT NULL DEFAULT ARRAY[60]::INTEGER[],
  lfg_alert_delivery TEXT NOT NULL DEFAULT 'off' CHECK (lfg_alert_delivery IN ('off', 'dm', 'thread', 'both')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id),
  CHECK (reminder_lead_minutes <@ ARRAY[15, 60, 1440]::INTEGER[])
);

CREATE TABLE game_notification_mutes (
  discord_user_id TEXT NOT NULL,
  steam_app_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, steam_app_id),
  FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE
);

CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('session_reminder', 'lfg_ownership_alert')),
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('dm', 'thread', 'both')),
  lead_minutes INTEGER,
  expected_starts_at TIMESTAMPTZ NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'skipped')),
  attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (status, scheduled_at) WHERE status = 'pending';

-- Source: 0008_session_cancellation_reason.sql
ALTER TABLE game_sessions ADD COLUMN cancellation_reason TEXT;

-- Source: 0009_guild_game_rules.sql
CREATE TABLE guild_game_rules (
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  steam_app_id INTEGER NOT NULL,
  min_players INTEGER NOT NULL CHECK (min_players >= 1 AND min_players <= 100),
  max_players INTEGER NOT NULL CHECK (max_players >= min_players AND max_players <= 100),
  configured_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, steam_app_id)
);

ALTER TABLE game_sessions ADD COLUMN min_players INTEGER;
ALTER TABLE game_sessions ADD COLUMN max_players INTEGER;

-- Source: 0010_guild_game_rule_ownership.sql
ALTER TABLE guild_game_rules ADD COLUMN requires_all_owners BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE game_sessions ADD COLUMN requires_all_owners BOOLEAN NOT NULL DEFAULT TRUE;

-- Source: 0011_hardening.sql
ALTER TABLE game_sessions ADD COLUMN registration_closed_at TIMESTAMPTZ;
ALTER TABLE game_sessions ADD COLUMN completed_at TIMESTAMPTZ;
ALTER TABLE guild_game_rules ADD COLUMN game_name TEXT;

CREATE TABLE guild_game_rule_revisions (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  steam_app_id INTEGER NOT NULL,
  game_name TEXT NOT NULL,
  min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  requires_all_owners BOOLEAN NOT NULL,
  changed_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX guild_game_rule_revisions_lookup_idx ON guild_game_rule_revisions (guild_id, steam_app_id, changed_at DESC);

-- Source: 0012_rallies.sql
CREATE TABLE voice_channel_members (
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id)
);
CREATE INDEX voice_channel_members_channel_idx ON voice_channel_members (guild_id, channel_id, observed_at DESC);

CREATE TABLE voice_gateway_status (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  connected_at TIMESTAMPTZ,
  last_event_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rallies (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  host_discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  voice_channel_id TEXT,
  roster_source TEXT NOT NULL CHECK (roster_source IN ('manual', 'voice')),
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'polling', 'locking', 'locked', 'cancelled', 'expired')),
  roster_locked_at TIMESTAMPTZ,
  poll_opened_at TIMESTAMPTZ,
  locked_game_session_id UUID REFERENCES game_sessions(id) ON DELETE SET NULL,
  cancellation_reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX rallies_active_idx ON rallies (guild_id, starts_at) WHERE state IN ('open', 'polling');

CREATE TABLE rally_members (
  rally_id UUID NOT NULL REFERENCES rallies(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'in' CHECK (status IN ('in', 'out')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'voice')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rally_id, discord_user_id)
);

CREATE TABLE rally_roster_snapshots (
  id UUID PRIMARY KEY,
  rally_id UUID NOT NULL UNIQUE REFERENCES rallies(id) ON DELETE CASCADE,
  voice_channel_id TEXT,
  gateway_observed_at TIMESTAMPTZ,
  participant_ids JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rally_candidates (
  rally_id UUID NOT NULL REFERENCES rallies(id) ON DELETE CASCADE,
  steam_app_id INTEGER NOT NULL,
  game_name TEXT NOT NULL,
  min_players INTEGER NOT NULL,
  max_players INTEGER NOT NULL,
  requires_all_owners BOOLEAN NOT NULL,
  viable_participant_ids JSONB NOT NULL,
  potential_participants INTEGER NOT NULL,
  PRIMARY KEY (rally_id, steam_app_id)
);

CREATE TABLE rally_votes (
  rally_id UUID NOT NULL REFERENCES rallies(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  steam_app_id INTEGER NOT NULL,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (rally_id, discord_user_id, rank),
  UNIQUE (rally_id, discord_user_id, steam_app_id),
  FOREIGN KEY (rally_id, steam_app_id) REFERENCES rally_candidates(rally_id, steam_app_id) ON DELETE CASCADE
);

CREATE TABLE rally_posts (
  rally_id UUID PRIMARY KEY REFERENCES rallies(id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Source: 0013_external_game_metadata.sql
CREATE TABLE external_games (
  steam_app_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_game_id BIGINT,
  provider_name TEXT,
  min_players INTEGER,
  max_players INTEGER,
  online BOOLEAN,
  online_coop BOOLEAN,
  local_multiplayer BOOLEAN,
  local_coop BOOLEAN,
  split_screen BOOLEAN,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  CHECK (steam_app_id > 0),
  CHECK (min_players IS NULL OR min_players >= 1),
  CHECK (max_players IS NULL OR max_players >= min_players)
);

-- Source: 0014_discord_message_traces.sql
CREATE TABLE discord_message_traces (
  id BIGSERIAL PRIMARY KEY,
  trace_id UUID NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  event_type TEXT NOT NULL,
  interaction_id TEXT,
  command TEXT,
  method TEXT,
  path TEXT,
  status INTEGER,
  request_body JSONB,
  response_body JSONB,
  response_text TEXT,
  error TEXT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX discord_message_traces_trace_id_idx ON discord_message_traces (trace_id, created_at);
CREATE INDEX discord_message_traces_created_at_idx ON discord_message_traces (created_at DESC);

-- Source: 0015_oauth_provider.sql
CREATE TABLE oauth_authorization_codes (
  id UUID PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_access_tokens (
  id UUID PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_authorization_codes_active_idx ON oauth_authorization_codes (code_hash, expires_at) WHERE redeemed_at IS NULL;
CREATE INDEX oauth_access_tokens_active_idx ON oauth_access_tokens (token_hash, expires_at) WHERE revoked_at IS NULL;

-- Source: 0016_feedback_notifications.sql
CREATE TABLE feedback_notification_preferences (
  discord_user_id TEXT PRIMARY KEY REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  owner_updates_enabled BOOLEAN NOT NULL DEFAULT true,
  participant_updates_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feedback_ticket_participants (
  ticket_number INTEGER NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_number, discord_user_id)
);
CREATE TABLE feedback_event_receipts (event_key TEXT PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE feedback_notification_deliveries (
  id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('feedback_status', 'feedback_comment')),
  ticket_number INTEGER NOT NULL,
  ticket_title TEXT NOT NULL,
  ticket_url TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'skipped')),
  attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feedback_notification_deliveries_due_idx ON feedback_notification_deliveries (status, created_at) WHERE status='pending';

-- Source: 0017_regular_game_nights.sql
CREATE TABLE regular_game_nights (
  id UUID PRIMARY KEY,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  host_discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE RESTRICT,
  cadence_weeks INTEGER NOT NULL CHECK (cadence_weeks IN (1, 2)),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE regular_game_night_members (
  regular_game_night_id UUID NOT NULL REFERENCES regular_game_nights(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  PRIMARY KEY (regular_game_night_id, discord_user_id)
);

ALTER TABLE game_sessions ADD COLUMN regular_game_night_id UUID REFERENCES regular_game_nights(id) ON DELETE SET NULL;
ALTER TABLE game_sessions ADD COLUMN regular_occurrence_index INTEGER;
CREATE UNIQUE INDEX game_sessions_regular_occurrence_idx
  ON game_sessions (regular_game_night_id, regular_occurrence_index)
  WHERE regular_game_night_id IS NOT NULL;
CREATE INDEX regular_game_nights_guild_host_idx ON regular_game_nights (guild_id, host_discord_user_id) WHERE active;

-- Source: 0018_live_roster.sql
CREATE TABLE session_live_statuses (
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('coming','running_late','here','leaving','joining_next_game')),
  updated_by_discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (game_session_id, discord_user_id)
);
CREATE TABLE session_live_status_events (
  id UUID PRIMARY KEY,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('coming','running_late','here','leaving','joining_next_game')),
  updated_by_discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Source: 0019_games_tonight.sql
CREATE TABLE game_night_games (
  id UUID PRIMARY KEY,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  steam_app_id INTEGER NOT NULL,
  game_name TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'up_next' CHECK (status IN ('up_next','now_playing','completed','skipped','replaced')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_session_id, position)
);
INSERT INTO game_night_games (id,game_session_id,position,steam_app_id,game_name,status)
SELECT md5(random()::text || clock_timestamp()::text)::uuid,id,0,steam_app_id,game_name,'up_next' FROM game_sessions;
CREATE UNIQUE INDEX game_night_games_one_now_playing_idx ON game_night_games (game_session_id) WHERE status='now_playing';
CREATE TABLE game_night_game_players (
  game_night_game_id UUID NOT NULL REFERENCES game_night_games(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  PRIMARY KEY (game_night_game_id, discord_user_id)
);
INSERT INTO game_night_game_players (game_night_game_id,discord_user_id)
SELECT g.id,r.discord_user_id FROM game_night_games g JOIN session_rsvps r ON r.game_session_id=g.game_session_id
WHERE r.response='accepted';

-- Source: 0020_game_night_change_notifications.sql
ALTER TABLE guild_notification_preferences
  ADD COLUMN game_night_change_delivery TEXT NOT NULL DEFAULT 'dm'
  CHECK (game_night_change_delivery IN ('off', 'dm', 'thread', 'both'));

ALTER TABLE notification_deliveries
  ADD COLUMN content TEXT;

ALTER TABLE notification_deliveries
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_kind_check,
  ADD CONSTRAINT notification_deliveries_kind_check
    CHECK (kind IN ('session_reminder', 'lfg_ownership_alert', 'game_night_change'));

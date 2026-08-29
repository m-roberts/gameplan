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

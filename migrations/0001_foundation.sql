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

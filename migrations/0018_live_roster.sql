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

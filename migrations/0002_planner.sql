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

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

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

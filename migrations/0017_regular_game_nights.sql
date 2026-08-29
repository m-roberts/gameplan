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

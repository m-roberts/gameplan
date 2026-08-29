ALTER TABLE guild_game_rules ADD COLUMN requires_all_owners BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE game_sessions ADD COLUMN requires_all_owners BOOLEAN NOT NULL DEFAULT TRUE;

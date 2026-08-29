ALTER TABLE game_sessions ADD COLUMN cancelled_at TIMESTAMPTZ;
ALTER TABLE game_sessions ADD COLUMN cancelled_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL;

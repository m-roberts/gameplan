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

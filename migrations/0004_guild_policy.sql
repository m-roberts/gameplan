CREATE TABLE guild_policies (
  guild_id TEXT PRIMARY KEY REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  default_lfg_channel_id TEXT,
  updated_by_discord_user_id TEXT REFERENCES discord_users(discord_user_id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE guild_policy_channels (
  guild_id TEXT NOT NULL REFERENCES guild_policies(guild_id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

CREATE TABLE guild_policy_coordinator_roles (
  guild_id TEXT NOT NULL REFERENCES guild_policies(guild_id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  PRIMARY KEY (guild_id, role_id)
);

ALTER TABLE browser_link_tickets ADD COLUMN guild_permissions TEXT;
ALTER TABLE browser_link_tickets ADD COLUMN guild_role_ids JSONB;
ALTER TABLE browser_sessions ADD COLUMN guild_permissions TEXT;
ALTER TABLE browser_sessions ADD COLUMN guild_role_ids JSONB;

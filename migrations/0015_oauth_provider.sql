CREATE TABLE oauth_authorization_codes (
  id UUID PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, redeemed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE oauth_access_tokens (
  id UUID PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL, revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX oauth_authorization_codes_active_idx ON oauth_authorization_codes (code_hash, expires_at) WHERE redeemed_at IS NULL;
CREATE INDEX oauth_access_tokens_active_idx ON oauth_access_tokens (token_hash, expires_at) WHERE revoked_at IS NULL;

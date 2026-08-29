CREATE TABLE discord_user_notification_settings (
  discord_user_id TEXT PRIMARY KEY REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  timezone TEXT NOT NULL DEFAULT 'Europe/London',
  quiet_start TIME,
  quiet_end TIME,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((quiet_start IS NULL AND quiet_end IS NULL) OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL)),
  CHECK (quiet_start IS NULL OR quiet_start <> quiet_end)
);

CREATE TABLE guild_notification_preferences (
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  reminder_delivery TEXT NOT NULL DEFAULT 'off' CHECK (reminder_delivery IN ('off', 'dm', 'thread', 'both')),
  reminder_lead_minutes INTEGER[] NOT NULL DEFAULT ARRAY[60]::INTEGER[],
  lfg_alert_delivery TEXT NOT NULL DEFAULT 'off' CHECK (lfg_alert_delivery IN ('off', 'dm', 'thread', 'both')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, discord_user_id),
  CHECK (reminder_lead_minutes <@ ARRAY[15, 60, 1440]::INTEGER[])
);

CREATE TABLE game_notification_mutes (
  discord_user_id TEXT NOT NULL,
  steam_app_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (discord_user_id, steam_app_id),
  FOREIGN KEY (discord_user_id) REFERENCES discord_users(discord_user_id) ON DELETE CASCADE
);

CREATE TABLE notification_deliveries (
  id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('session_reminder', 'lfg_ownership_alert')),
  guild_id TEXT NOT NULL REFERENCES guild_installations(guild_id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  delivery TEXT NOT NULL CHECK (delivery IN ('dm', 'thread', 'both')),
  lead_minutes INTEGER,
  expected_starts_at TIMESTAMPTZ NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'skipped')),
  attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notification_deliveries_due_idx ON notification_deliveries (status, scheduled_at) WHERE status = 'pending';

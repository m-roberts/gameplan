CREATE TABLE feedback_notification_preferences (
  discord_user_id TEXT PRIMARY KEY REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  owner_updates_enabled BOOLEAN NOT NULL DEFAULT true,
  participant_updates_enabled BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE feedback_ticket_participants (
  ticket_number INTEGER NOT NULL,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  PRIMARY KEY (ticket_number, discord_user_id)
);
CREATE TABLE feedback_event_receipts (event_key TEXT PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE feedback_notification_deliveries (
  id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('feedback_status', 'feedback_comment')),
  ticket_number INTEGER NOT NULL,
  ticket_title TEXT NOT NULL,
  ticket_url TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'skipped')),
  attempted_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX feedback_notification_deliveries_due_idx ON feedback_notification_deliveries (status, created_at) WHERE status='pending';

ALTER TABLE guild_notification_preferences
  ADD COLUMN game_night_change_delivery TEXT NOT NULL DEFAULT 'dm'
  CHECK (game_night_change_delivery IN ('off', 'dm', 'thread', 'both'));

ALTER TABLE notification_deliveries
  ADD COLUMN content TEXT;

ALTER TABLE notification_deliveries
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE notification_deliveries
  DROP CONSTRAINT notification_deliveries_kind_check,
  ADD CONSTRAINT notification_deliveries_kind_check
    CHECK (kind IN ('session_reminder', 'lfg_ownership_alert', 'game_night_change'));

CREATE TABLE game_night_games (
  id UUID PRIMARY KEY,
  game_session_id UUID NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  steam_app_id INTEGER NOT NULL,
  game_name TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'up_next' CHECK (status IN ('up_next','now_playing','completed','skipped','replaced')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_session_id, position)
);
INSERT INTO game_night_games (id,game_session_id,position,steam_app_id,game_name,status)
SELECT md5(random()::text || clock_timestamp()::text)::uuid,id,0,steam_app_id,game_name,'up_next' FROM game_sessions;
CREATE UNIQUE INDEX game_night_games_one_now_playing_idx ON game_night_games (game_session_id) WHERE status='now_playing';
CREATE TABLE game_night_game_players (
  game_night_game_id UUID NOT NULL REFERENCES game_night_games(id) ON DELETE CASCADE,
  discord_user_id TEXT NOT NULL REFERENCES discord_users(discord_user_id) ON DELETE CASCADE,
  PRIMARY KEY (game_night_game_id, discord_user_id)
);
INSERT INTO game_night_game_players (game_night_game_id,discord_user_id)
SELECT g.id,r.discord_user_id FROM game_night_games g JOIN session_rsvps r ON r.game_session_id=g.game_session_id
WHERE r.response='accepted';

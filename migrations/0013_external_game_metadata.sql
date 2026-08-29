CREATE TABLE external_games (
  steam_app_id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_game_id BIGINT,
  provider_name TEXT,
  min_players INTEGER,
  max_players INTEGER,
  online BOOLEAN,
  online_coop BOOLEAN,
  local_multiplayer BOOLEAN,
  local_coop BOOLEAN,
  split_screen BOOLEAN,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  CHECK (steam_app_id > 0),
  CHECK (min_players IS NULL OR min_players >= 1),
  CHECK (max_players IS NULL OR max_players >= min_players)
);

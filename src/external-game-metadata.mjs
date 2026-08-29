export class ExternalGameMetadataService {
  constructor({ database, client }) {
    this.database = database;
    this.client = client;
  }

  async refreshGames(games) {
    if (!this.client?.configured()) return { attempted: 0, enriched: 0 };
    let attempted = 0;
    let enriched = 0;
    for (const game of games ?? []) {
      if (!Number.isInteger(game.appId) || game.appId <= 0) continue;
      attempted += 1;
      try {
        const metadata = await this.client.findSteamGame(game.appId);
        await this.save(game.appId, metadata);
        if (metadata) enriched += 1;
      } catch (error) {
        await this.database.query(
          `INSERT INTO external_games (steam_app_id,provider,last_error,fetched_at)
           VALUES ($1,'igdb',$2,now())
           ON CONFLICT (steam_app_id) DO UPDATE SET provider='igdb',last_error=EXCLUDED.last_error,fetched_at=EXCLUDED.fetched_at`,
          [game.appId, error.message],
        );
      }
    }
    return { attempted, enriched };
  }

  async save(appId, metadata) {
    await this.database.query(
      `INSERT INTO external_games
         (steam_app_id,provider,provider_game_id,provider_name,min_players,max_players,online,online_coop,local_multiplayer,local_coop,split_screen,last_error,fetched_at)
       VALUES ($1,'igdb',$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,now())
       ON CONFLICT (steam_app_id) DO UPDATE SET
         provider='igdb',provider_game_id=EXCLUDED.provider_game_id,provider_name=EXCLUDED.provider_name,
         min_players=EXCLUDED.min_players,max_players=EXCLUDED.max_players,online=EXCLUDED.online,
         online_coop=EXCLUDED.online_coop,local_multiplayer=EXCLUDED.local_multiplayer,
         local_coop=EXCLUDED.local_coop,split_screen=EXCLUDED.split_screen,last_error=NULL,fetched_at=now()`,
      [appId, metadata?.providerGameId ?? null, metadata?.providerName ?? null, metadata?.minPlayers ?? null, metadata?.maxPlayers ?? null, metadata?.online ?? null, metadata?.onlineCoop ?? null, metadata?.localMultiplayer ?? null, metadata?.localCoop ?? null, metadata?.splitScreen ?? null],
    );
  }
}

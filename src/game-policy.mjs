import metadata from '../catalog/game-metadata.json' with { type: 'json' };

const policies = new Map(metadata.map((game) => [game.appId, game]));

export function gamePolicy(appId, fallbackTitle) {
  const policy = policies.get(appId);
  return policy ? { ...policy } : {
    appId,
    canonicalTitle: fallbackTitle,
    minPlayers: null,
    maxPlayers: null,
    policyNote: 'Player-count support has not been curated yet. Confirm it before inviting people.',
  };
}

export function gameFitsParty(policy, partySize) {
  return (!policy.minPlayers || partySize >= policy.minPlayers) && (!policy.maxPlayers || partySize <= policy.maxPlayers);
}

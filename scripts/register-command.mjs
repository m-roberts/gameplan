import { command } from '../src/command-definition.mjs';

const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;

if (!applicationId || !botToken) {
  throw new Error('DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN are required');
}

const headers = {
  authorization: `Bot ${botToken}`,
  'content-type': 'application/json',
};
const configuredGuildIds = [
  ...(process.env.DISCORD_GUILD_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
  ...(process.env.DISCORD_GUILD_ID ? [process.env.DISCORD_GUILD_ID] : []),
];
let discoveredGuildIds = [];
if (process.env.DISCORD_DISCOVER_GUILDS === 'true') {
  const response = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers });
  if (!response.ok) throw new Error(`guild discovery: Discord returned HTTP ${response.status}: ${await response.text()}`);
  discoveredGuildIds = (await response.json()).map((guild) => guild.id);
}
const guildIds = [...new Set([...configuredGuildIds, ...discoveredGuildIds])];
const scopes = [{
  name: 'global',
  endpoint: `https://discord.com/api/v10/applications/${applicationId}/commands`,
  commands: [command],
}];
if (process.env.DISCORD_REGISTER_GUILDS === 'true' || process.env.DISCORD_CLEAR_GUILDS === 'true' || process.env.DISCORD_DISCOVER_GUILDS === 'true') {
  scopes.push(...guildIds.map((guildId) => ({
    name: `guild:${guildId}`,
    endpoint: `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`,
    commands: process.env.DISCORD_CLEAR_GUILDS === 'true' ? [] : [command],
  })));
}

for (const scope of scopes) {
  const response = await fetch(scope.endpoint, {
    method: 'PUT',
    headers,
    body: JSON.stringify(scope.commands),
  });

  if (!response.ok) throw new Error(`${scope.name}: Discord returned HTTP ${response.status}: ${await response.text()}`);
  const commands = await response.json();
  console.log(JSON.stringify({ registered: true, scope: scope.name, commands }, null, 2));
}

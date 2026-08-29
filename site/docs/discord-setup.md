# Discord application setup

GamePlan receives Discord interactions over HTTPS and makes Discord REST and
gateway calls as its bot. Create a Discord application owned by the person or
organisation that will operate the installation, then add a bot user to it.

## Application settings

In the Discord Developer Portal:

1. Create an application and add a bot.
2. Copy the **Application ID** to `DISCORD_APPLICATION_ID`.
3. Copy the **Public Key** from General Information to `DISCORD_PUBLIC_KEY`.
4. Reset/copy the bot token to `DISCORD_BOT_TOKEN`, storing it only in `.env`.
5. Set **Interactions Endpoint URL** to
   `https://<your-host>/discord/interactions`. Discord must be able to reach
   it over valid public HTTPS.
6. Under Bot → Privileged Gateway Intents, enable **Server Members Intent**.
   GamePlan uses it to maintain the server membership view. It does not need
   Message Content or Presence Intent.

## Install link and permissions

Generate an installation URL in OAuth2 → URL Generator with these scopes:

- `bot`
- `applications.commands`

Give the bot only these permissions:

- View Channels
- Send Messages
- Send Messages in Threads
- Embed Links
- Create Public Threads
- Read Message History

Avoid Administrator. Server owners can still restrict GamePlan to selected
channels with normal Discord channel permissions. The person running
`/gameplan server` needs Discord's Manage Server or Administrator permission;
the bot itself does not.

Install the generated link in each Discord server that should use this
GamePlan instance, then register the slash command as described in the
[quick start](quickstart.md).

## Verify the connection

After command registration:

1. Run `/gameplan help` in an installed server.
2. Have an administrator run `/gameplan server` and select a Session Feed
   channel where the bot can post.
3. Run `/gameplan invite` in a channel where the bot has View Channel and Send
   Messages permission.
4. Use `/gameplan me` and confirm that its one-time browser link opens on
   your configured public address.

If Discord cannot validate the interaction endpoint, check the public HTTPS
certificate, reverse-proxy route, and `PUBLIC_BASE_URL`; then inspect the app
logs with `docker compose logs app`.

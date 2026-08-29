# Quick start

This guide runs one self-hosted GamePlan installation. For a real group, use
an always-on server with a public HTTPS address; see [operations](operations.md).

## What you need

- A machine that can run Docker Compose. A small VPS is sufficient for an
  initial community. Providers such as Hetzner are one example; choose a
  region, price, and support level appropriate for your group.
- A DNS name that points at that machine and a reverse proxy that terminates
  HTTPS.
- A Discord application and bot. The exact setup is in
  [Discord application setup](discord-setup.md).
- A Steam Web API key from the Steam partner/developer tools.

## Configure GamePlan

Clone the repository, then make the environment file private to the host:

```sh
git clone https://github.com/<your-account>/gameplan.git
cd gameplan
cp .env.example .env
chmod 600 .env
```

Set every `change-me` or blank required value in `.env`:

| Setting | Purpose |
| --- | --- |
| `PUBLIC_BASE_URL` | The exact public HTTPS origin, for example `https://gameplan.example.com`. |
| `POSTGRES_PASSWORD` | Password for this installation's PostgreSQL database. |
| `APP_SECRET` | At least 32 random characters used to protect browser links and sessions. |
| `STEAM_WEB_API_KEY` | Steam API key used to read a player's public library. |
| `DISCORD_APPLICATION_ID` | Discord application ID; needed when registering commands. |
| `DISCORD_PUBLIC_KEY` | Discord public key used to verify incoming interactions. |
| `DISCORD_BOT_TOKEN` | Bot token. Keep it only in the private `.env` file. |

Generate a secret, for example:

```sh
openssl rand -base64 48
```

Do not commit `.env`, paste its values into tickets, or share it in Discord.

## Start the stack

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:${HOST_PORT:-3000}/healthz
```

Compose starts PostgreSQL, applies idempotent migrations, the interaction web
service, and the notification worker. The Postgres data lives in the named
`gameplan_postgres_data` volume. It is the data that must be backed up.

Put the app behind a reverse proxy and set the Discord Interactions Endpoint
URL to:

```text
https://<your-host>/discord/interactions
```

Then register the command once from the configured host:

```sh
docker compose exec app npm run register-command
```

Global commands can take time to appear. For fast testing in explicitly named
test servers, set `DISCORD_REGISTER_GUILDS=true` and `DISCORD_GUILD_IDS` before
running the same command. Do not leave both global and guild registrations
enabled unintentionally.

Finish by using `/gameplan server` in Discord and choosing a Session Feed.

## Optional feedback integration

Feedback is intentionally optional. Configure `FEEDBACK_URL` and
`FEEDBACK_WEBHOOK_SECRET` only if you operate a compatible feedback service.
The service must be configured to send comment and status webhooks to
`https://<your-host>/webhooks/fider`, authenticated with
`Authorization: Bearer <FEEDBACK_WEBHOOK_SECRET>`.

Without those settings, the feedback commands simply report that feedback is
not configured.

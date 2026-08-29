# Operating GamePlan

GamePlan is a small service, but it is an always-on service. Discord needs to
reach its interactions endpoint at any time, browser links need the same public
origin, and the notification worker needs to run continuously.

## Host and network

Run it on a maintained machine that stays online: a VPS, home server with a
reliable public route, or managed container platform. A low-cost VPS such as a
Hetzner cloud instance is a common starting point; GamePlan does not depend on
one provider.

Use a DNS name, a reverse proxy (for example Caddy, Nginx, or Traefik), and a
valid TLS certificate. Expose only HTTPS publicly. Keep PostgreSQL on the
private Docker network—do not publish port 5432. Restrict SSH, apply operating
system security updates, and keep Docker current.

`PUBLIC_BASE_URL` must be the canonical public HTTPS origin. Changing it
invalidates assumptions in one-time browser links and requires updating the
Discord interaction endpoint as well.

## Start-up and health

```sh
docker compose up --build -d
docker compose ps
curl --fail http://127.0.0.1:${HOST_PORT:-3000}/healthz
docker compose logs --tail=100 app notifications
```

Configure your host's service manager or deployment system to restart Docker
and bring this Compose project back after a reboot. Check the health endpoint
from the reverse proxy or monitoring system, and alert on failed health checks,
container restart loops, low disk space, and database backup failures.

## Backups and restore drills

Back up PostgreSQL before every upgrade and on a schedule. A logical backup is
portable:

```sh
docker compose exec -T db pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" > gameplan-$(date +%F).sql
```

Keep encrypted backups somewhere other than the GamePlan host, and periodically
restore one into a disposable database. A backup that has never been restored
is only a hope.

To restore, stop GamePlan, restore into a replacement database/volume, start
the stack, then verify `/healthz` and a non-destructive Discord interaction.
Do not delete the named database volume as part of ordinary shutdown or update
work.

## Updates and rollbacks

Read the release notes, take a backup, then update a pinned release tag or
reviewed commit:

```sh
git fetch --tags
git checkout <reviewed-release-tag>
docker compose build --pull
docker compose up -d
docker compose ps
```

The standard single-Compose update may briefly restart the web process. Discord
retries failed interactions, but use a rolling deployment if you need to avoid
that interruption. The [rolling deployment guide](rolling-deployments.md)
describes a provider-neutral blue/green pattern.

Database migrations are forward-only. Do not roll the database back by deleting
migration records. If an application rollback is needed after a migration,
restore the pre-upgrade database backup or use a release explicitly compatible
with the newer schema. See [migration policy](migrations.md).

## Incidents

Start with the state and logs:

```sh
docker compose ps
docker compose logs --tail=200 app notifications migrate
```

For a suspected secret leak, rotate the affected Discord token, Steam key,
database password, or `APP_SECRET`; then replace the host's `.env` and restart
the stack. Treat copied logs and CI output as potentially sensitive. See
[security and data handling](security-and-data.md).

# Rolling deployments

The default Compose file is intentionally simple and may briefly restart the
web process during an upgrade. This guide describes the shape of a generic
blue/green deployment for operators who need an always-on public endpoint.

## The model

Keep one stable HTTPS reverse proxy in front of two independently named app
stacks, **blue** and **green**. Both connect to the same PostgreSQL database,
but only one notification worker runs at a time so reminders are never sent
twice.

```text
Discord and browsers → HTTPS proxy → blue app (active)
                                  └→ green app (candidate)
                                           ↓
                                      shared PostgreSQL
```

The proxy exposes the candidate only after its `/healthz` succeeds. Then it
drains existing blue requests, switches upstream, and stops blue. The public
hostname and `PUBLIC_BASE_URL` do not change.

## Safe sequence

1. Pin the release you intend to deploy and take a PostgreSQL backup.
2. Build and start the inactive app stack on a private port with the same
   public base URL and database. Do not start its notification worker yet.
3. Wait for its `/healthz` check and inspect its logs. Run a non-mutating
   Discord interaction against it only if your proxy supports a temporary
   private route.
4. Apply any required migration once. Migrations must complete before the
   candidate receives traffic.
5. Change the proxy upstream atomically from blue to green, retaining the same
   certificate and hostname.
6. Start the candidate notification worker and stop the old worker in one
   controlled hand-off. Verify that only one worker is running.
7. Watch health and logs, then stop the old app stack after the proxy's drain
   period.

Use your platform's native rolling mechanism when it provides these guarantees.
For Compose, operators commonly implement the proxy switch using Caddy,
Nginx, or Traefik and two Compose project names. The exact proxy syntax is
deliberately not prescribed here: it should be owned, reviewed, and tested by
the operator rather than copied from a deployment-specific example.

## Important limits

Blue/green avoids a web-service gap; it does not make an unsafe schema change
safe. Releases must tolerate the old and new app briefly sharing a database,
or the migration must happen during a planned maintenance window. Never run two
notification workers against the same reminder queue. Exercise this procedure
on a non-production host before relying on it for a live group.

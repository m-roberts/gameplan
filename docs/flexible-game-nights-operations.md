# Flexible Game Nights: operator guide

GamePlan runs one `notification-worker` process alongside the web and Discord
interaction service. It materialises regular Game Nights, closes sessions that
have started, and sends reminders and Games Tonight change notifications.

## Check the service

In a Compose deployment, check that both the application and notification
worker are running, then inspect the worker logs:

```sh
docker compose ps
docker compose logs --tail=100 gameplan-notifications
```

The HTTP health endpoint (`/healthz`) confirms the application can reach its
database. A healthy web process does not by itself prove that queued Discord
notifications are being delivered, so use the delivery table when diagnosing a
reported missed alert:

```sql
SELECT kind, status, attempt_count, failure_reason, scheduled_at, attempted_at, delivered_at
FROM notification_deliveries
ORDER BY created_at DESC
LIMIT 50;
```

GamePlan retries a failed Discord delivery twice, five minutes apart. A final
`failed` row is intentionally retained for inspection; it is never silently
dropped. Fix the Discord permission or DM problem first, then requeue one row
only when it is still useful:

```sql
UPDATE notification_deliveries
SET status = 'pending', scheduled_at = now(), attempted_at = NULL, failure_reason = NULL, attempt_count = 0
WHERE id = '<delivery UUID>' AND status = 'failed';
```

## Safe recovery

Restarting the notification worker is safe. Pending rows are claimed with a
database lock and have an immutable dedupe key, so a restart does not turn a
single Games Tonight change into a guild-wide announcement. If a worker dies
after claiming a row, inspect it before resetting its status to `pending`.

Games Tonight updates are host actions. GamePlan records an unmentioned
discussion entry, then sends opted-in recipient notifications as DMs by
default. It never uses `@everyone` or `@here`. A person can choose Off, DM,
thread, or both in `/gameplan notifications` or the private web Notifications
view.

For an unexpected roster or game choice, do not edit database rows directly.
The host should use the live roster status and **Replan for live roster**
controls; this preserves the discussion history and applies the current
shared-library compatibility checks.

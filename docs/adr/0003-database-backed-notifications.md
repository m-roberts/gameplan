# Database-backed notifications

## Decision

GamePlan stores notification preferences and deduplicated Delivery Attempts in
PostgreSQL. A separate Compose worker claims due attempts before making any
Discord API call. It never retries an attempt once claimed, because Discord
message creation is not idempotent and duplicate player notifications are worse
than a recorded failed delivery in pre-alpha.

## Consequences

The app remains self-hostable with Docker Compose and no external queue. Failed
or interrupted attempts remain visible in the database rather than silently
creating duplicate DMs after a worker restart.

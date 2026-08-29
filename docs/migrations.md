# Database migrations

GamePlan has two migration paths.

- A **fresh installation** applies `0000_baseline.sql`, the complete current
  schema snapshot, then records the historical migration names as satisfied.
- An **existing installation** continues through the numbered migrations it has
  not yet applied. Historical files remain in the repository so an older
  supported database can upgrade automatically.

Never edit a migration that may already have been applied by an operator. Add a
new numbered migration for every future schema change, then refresh the fresh
install baseline in the same pull request. `npm test` verifies that the
baseline contains every historical migration in order.

Before upgrading production, take a PostgreSQL backup. A failed migration is
rolled back as one transaction; application rollback is safe only while its
schema expectations remain compatible with the migrated database.

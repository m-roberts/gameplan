# Security and data handling

GamePlan v1 keeps the identity surface deliberately small:

- Discord User IDs, an optional Discord display name, Steam IDs, ownership
  snapshots, and planned-game data are stored in PostgreSQL.
- Steam OpenID proves a Steam ID. GamePlan never asks for or stores a Steam
  password, Steam session cookie, or launcher credential.
- Raw Browser Link, Browser Session, CSRF, and Steam-link state tokens are
  never stored. PostgreSQL holds an HMAC-SHA-256 value keyed by `APP_SECRET`,
  so a database dump cannot be used to redeem a token.
- Browser Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` on an
  HTTPS deployment. The non-HTTP-only CSRF cookie is `SameSite=Strict` and
  must match the server-side HMAC before a mutation is accepted.
- Browser Links expire after ten minutes and are atomically consumed once.

Self-hosted operators should inject `APP_SECRET`, the Steam key, and Discord
public key through their secret manager rather than source control; protect
the PostgreSQL volume and backups with the host's encrypted storage. The
application cannot provide disk encryption for an operator's host.

`DELETE /api/steam/connection` removes the Steam Connection and all linked
ownership data by cascading database constraints. `DELETE /api/me` removes the
Discord User and all data that is solely owned by it; the browser account UI
will expose that control with the planner.

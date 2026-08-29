# ADR 0001: Use bot-issued Browser Links for browser identity

- Status: accepted
- Date: 2026-08-23

## Context

GamePlan v1 is a browser app used from Discord. It needs to know which
Discord User is linking a Steam Connection and later creating or answering
Game Sessions. Requiring a password creates a new identity system; requiring
Discord OAuth adds a browser authorisation flow without improving the v1
planning experience. Discord Activities are explicitly out of scope.

## Decision

The project-owned Discord bot issues a single-use, short-lived Browser Link
for the Discord User who invoked a command. Opening it consumes the ticket and
creates an opaque, server-side Browser Session represented by a secure,
HTTP-only cookie. Discord's immutable user ID is the canonical identity.

Steam OpenID is used only to verify a Steam ID for a Steam Connection. GamePlan
stores no Steam credential and uses its server Web API key only to read an
eligible public Steam library.

## Consequences

- No password, Discord OAuth client secret, or Activity configuration is needed
  for v1.
- The bot must be installed in a guild before a user can open GamePlan; a
  later standalone sign-in would be a deliberate new identity path.
- Tickets and sessions need durable storage, expiry, replay protection and
  explicit deletion behaviour.
- A link opened on another device remains deliberately usable until it expires;
  possession of the Discord-delivered URL is the authentication factor.

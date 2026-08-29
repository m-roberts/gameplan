# ADR 0002: Separate host transfer, leaving, and cancellation

- Status: accepted
- Date: 2026-08-23

## Context

Published-session participants must be able to withdraw without destroying a Game Session.
The session host, however, owns the time, note, invitations, and public session
post. Treating a host leaving as implicit cancellation makes a participant
change destructive; keeping the host after they leave makes the roster
misleading.

## Decision

Cancellation is an explicit host operation. A host who wishes to leave must
first transfer the Host role to another confirmed participant. A session with
no confirmed participants is automatically cancelled.

## Consequences

- Public session cards can always distinguish joining from leaving.
- The roster has an active, confirmed host.
- Host transfer needs an explicit Discord interaction; it is not inferred from
  RSVP changes.

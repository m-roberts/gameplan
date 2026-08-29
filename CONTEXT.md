# GamePlan language

GamePlan is a Discord-first planner for groups who already own games on Steam.
The browser is an optional companion for linking Steam and working across more
space; every core workflow is available from the bot. These terms are the
shared language for product, code, and data.

| Term | Meaning | Avoid |
| --- | --- | --- |
| **Discord User** | A person identified by Discord's immutable user ID. This is GamePlan's canonical person identity. | `Account`, `Discord account` |
| **Browser Link** | A one-time, short-lived URL issued by the bot to open a browser session for one Discord User. | `Login link`, `OAuth link` |
| **Browser Session** | The server-side authenticated browser state represented by an opaque secure cookie. | `Session` when discussing a planned game |
| **Steam Connection** | A verified association between one Discord User and one Steam ID, created through Steam OpenID. No Steam credential is stored. | `Steam account` |
| **Ownership Snapshot** | The result of one Steam library sync, including whether the library was visible at that moment. | `Library` when referring to a historical sync |
| **Guild Installation** | The bot being available in a Discord server, identified by its immutable guild ID. | `Server account` |
| **Game Night** | A planned evening with a time, host, people, a discussion thread, and a chosen game. | `Session`, `Party`, `Rally` as a top-level user concept |
| **Regular Game Night** | A weekly or fortnightly rhythm that creates independently editable Game Nights. | `Series`, `recurrence` |
| **Planning Approach** | One of three ways to start a Session: pick a game with selected people, decide a game together after attendance, or use the people currently in voice. | `Mode` |
| **Game Vote** | The attendance-and-ranked-choice stage used when a Session's game is still undecided. A chosen winner becomes a Game Session. | `Rally` |
| **Party** | The explicit set of Discord Users whose Steam ownership is compared while picking a game. | `Lobby` |
| **RSVP** | A participant's response to a Game Session invitation. | `Acceptance` |
| **Host Transfer** | The explicit reassignment of a Game Session from its current host to a confirmed participant before the current host leaves. | `Host leaves` |
| **Cancellation** | An explicit end to a Game Session by its host; it is not a side effect of leaving. | `Leave` |
| **Game Policy** | Curated title and player-count guidance for a Steam app ID. Unknown games remain visible but are marked uncurated. | `Filter` |
| **Guild Game Rule** | A Discord server’s reusable player-count range and ownership requirement for a Steam game, contributed when that game has no curated guidance. | `Global game config` |
| **Session Feed** | The one server channel where every confirmed Game Session is automatically published. | `LFG channel` |
| **Game Alert** | An opt-in notification about a newly published Game Session for a game a Discord User owns. | `LFG alert` |
| **Notification Preference** | A Discord User's opt-in delivery choices for one Guild Installation, including session reminders and Game Alerts. | `Notification setting` when the server scope matters |
| **Muted Game** | A Steam app ID a Discord User has excluded from Game Alerts everywhere. | `Ignored game` |
| **Delivery Attempt** | One deduplicated outbound reminder or Game Alert, with a terminal recorded outcome. | `Notification` when referring to a preference or message |
| **Guild Policy** | A Discord server’s Session Feed configuration. | `Server settings` |

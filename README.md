# SyncSpace

[![CI](https://github.com/sinchalkar001-dev/SyncSpace/actions/workflows/ci.yml/badge.svg)](https://github.com/sinchalkar001-dev/SyncSpace/actions/workflows/ci.yml)

Real-time collaborative whiteboard and code editor. Two people open the same room and draw on a
shared canvas while editing a shared code buffer — concurrent edits merge through CRDTs rather than
last-write-wins.

Rooms sync live, survive a server restart, and can be replayed from an append-only log.

## Stack

**Client** — React 18 · Vite 6 · Yjs · `@hocuspocus/provider` · react-konva · Monaco + `y-monaco` ·
Zustand · React Router · socket.io-client

**Server** — Node 20+ ESM · Express 4 · `@hocuspocus/server` + `ws` · Socket.io · MongoDB + Mongoose ·
JWT + bcryptjs · zod · pino · nodemailer · helmet / cors / rate-limit

## Running it

```bash
npm install
npm run dev           # server on :4000, client on :5173
```

Both halves have to be running: the client proxies `/api`, `/collab` and `/socket.io` to the server,
so with only the client up every room sits at "Connecting" and the terminal fills with proxy errors.
`npm run dev` starts the pair and stops them together. To run one alone — two terminals, or one under
a debugger — `npm run dev:server` and `npm run dev:client` still do exactly that.

**MongoDB.** The server expects `mongodb://127.0.0.1:27017/syncspace`. Three ways to get one:

| Situation | Command |
| --- | --- |
| MongoDB installed locally | nothing — it is the default |
| Docker available | `docker compose up -d` |
| Neither | `npm run dev:memory` |

`dev:memory` boots the same pair against a throwaway in-memory MongoDB. Everything written is lost on
exit — it is for trying things out, not for keeping work.

Other scripts: `npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Accounts and access

Two ways in, both first-class:

- **Signed in** — register or sign in, get a JWT, and keep a dashboard of your rooms. Rooms you
  create are private and invite-only.
- **Guest** — open a room link and pick a display name. Guests reach public rooms only.

Inside a room, the avatar stack in the header opens the same roster: who is connected right now,
who is invited but away, and — for the owner — an invite field and a **Remove** button beside each
name. Removing someone withdraws their membership *and* keeps them out of a public room, which a
plain membership change cannot do while the link still works; it closes their live document and
presence connections on the spot, and an invite lets them back. Guests have no account to withdraw,
so the way to clear them out is **Make private**, offered in the same panel.

Guest access is deliberate: the interview scenario in the brief needs a candidate to join from a
link without signing up. The server enforces the same rule the UI shows, and refuses to boot in
production with `ALLOW_ANONYMOUS=true`.

Sign out lives in the account menu at the top right of both the dashboard and any room. It clears
the token, drops you back to a guest identity, and reconnects the room with the new credentials.

**Outgoing mail.** Two things are sent: the sign-up confirmation link, valid for 24 hours, and a
room invitation. With no relay configured both are written to the server log instead, which is all
development needs — the invite toast says as much and hands you the room code to pass on yourself.

Copy `server/.env.example` to `server/.env` and fill in the relay. For Gmail that means turning on
[2-Step Verification](https://myaccount.google.com/signinoptions/twosv) first — app passwords do not
exist as an option until it is on, and the page offers no hint that this is why — then generating an
[app password](https://myaccount.google.com/apppasswords) and pasting the sixteen characters exactly
as Google prints them; the spaces are display only and are stripped for you. Nothing here is
Gmail-specific, so an account whose administrator has switched app passwords off can point the same
four settings at any SMTP provider. Then prove it before an invitation depends on it:

```bash
cd server && npm run mail:check -- you@example.com
```

That connects, sends a real message, and on failure prints the provider's own answer rather than a
masked summary — a wrong app password says `535 Username and Password not accepted`, which is the
one thing the app itself will never tell you.

| Variable | Default | Meaning |
| --- | --- | --- |
| `SMTP_HOST` | *(unset)* | Relay hostname, e.g. `smtp.gmail.com`. Unset (and no `SMTP_URL`) = log emails instead of sending |
| `SMTP_PORT` | `587` | `587` for STARTTLS, `465` for implicit TLS |
| `SMTP_USER` | *(unset)* | Login. Whitespace-insensitive password below; both or neither |
| `SMTP_PASS` | *(unset)* | App password. Spaces are stripped, so paste it as shown |
| `SMTP_SECURE` | port is `465` | Override TLS-from-the-first-byte if your relay is unusual |
| `SMTP_URL` | *(unset)* | The whole relay as one URL instead of the parts above. Use one form or the other, never both; a password containing `@` or `:` must be percent-encoded here |
| `MAIL_FROM` | `SMTP_USER` | From-header, e.g. `SyncSpace <no-reply@syncspace.example>`. Required when the login is not itself an address |
| `CLIENT_URL` | first `CORS_ORIGIN` | Absolute origin the emailed links point at |

Credentials live only in the environment — never in code or logs. Delivery failures are logged with
a masked recipient and an error code only, and the resend endpoint reports "sent" without exposing
provider state. A relay outage never fails sign-up or an invite: the account and the membership
exist either way.

The room header carries four panels beside the presence stack. **People** is the roster and the
invite controls. **Chat** is live text for the room, kept in memory only — nothing is stored on
either side, so anyone joining later starts from an empty transcript and the panel says so.
**Files** is everything shared in the room: images, PDFs and text files up to 10 MB, listed newest
first with their size and age.

A file is refused before it leaves the browser if the server would refuse it anyway, so ten
megabytes are not pushed up the wire to be told no — the message names the file and its actual
size. Saving one goes through an authenticated request rather than a plain link, because the
download route needs a bearer token and an `<a href>` cannot carry one; the bytes are handed to the
browser from memory. **Remove** appears only on your own files, matching the server rule that only
the uploader or the room owner may delete. Every file route needs an account, so a guest in a
public room is told that rather than shown a panel that could only fail.

**History** replays how the room was built. The scrubber runs over the update log, and dragging it
shows the board and the buffer exactly as they stood at that point; play walks forward from there
at a chosen speed. Two properties of Yjs decide the whole design: updates only ever add, so a frame
cannot be produced by rewinding the one before it, and they commute, so the state at a point is the
fold of everything up to it. That fold is `/replay/:seq`'s job, and every position gets a fresh
document built from the answer. Frames are cached by sequence number and the next one is fetched
during the current one's dwell time, so playback steps on a cache hit rather than a round trip; a
slow connection plays slowly rather than queueing steps it cannot keep up with. Nothing in the
viewer writes, and it is not connected to the live document — the room carries on behind it.

One response carries at most 500 entries, which a room passes within a few minutes of typing, so
`/replay` takes a `from` bound and the viewer pages with the last sequence number it saw. Paging is
safe here in a way it rarely is: the log is append-only, so a page already read cannot change
underneath the reader.

The fold itself is where the cost was. Asking for the state at a sequence number meant replaying
every entry from the first one, so a frame got more expensive the longer the room had been alive —
160ms each on a 3,000 entry log, against a scrubber that steps every 420ms. **Checkpoints** are the
answer: every 250 entries the room records its whole state, and a read starts from the newest one
at or before the position it wants. The same benchmark then costs 15.7ms a frame, and stops growing
with the room's age (`node scripts/replay-bench.js` prints both sides).

Two things keep that honest. A checkpoint is built by folding the log, never by copying a live
in-memory document — a document only equals the log when nothing has gone wrong, and a checkpoint
that disagrees with the log is a replay that quietly shows the wrong thing. And each one stores how
many entries it folded, so if an entry numbered below it ever lands afterwards, the count no longer
matches and readers refuse it and fold from the beginning instead. Refusing is merely slow; using it
would drop somebody's edit without saying so.

Rooms whose history predates all this get their checkpoints from
`node scripts/backfill-checkpoints.js`, which is safe to run repeatedly and against a live database:
it only ever adds or repairs a derived cache, and never touches the log.

A room created without a name leads with its code and an `Unnamed` chip rather than a shared
"Untitled room" label, so two unnamed rooms are never indistinguishable, and each card carries a
stable identity stripe derived from its code.

Each room on the dashboard has its own menu. **People** shows the owner and invited members
alongside everyone who has actually opened the room — guests included, since they are recorded by
visit rather than by invitation. The owner can invite someone by email address there, or put them
out again. An invite emails the person a link to the room and the room code on its own line, since a
private room is otherwise invisible to them; inviting somebody already in the room sends it again,
which is how an owner re-sends a code that never arrived.

An address nobody has signed up with is invited all the same. Membership is by account id and there
is no account to point at yet, so the address is held on the room and the email leads with creating
one; the moment somebody registers with it, every invitation waiting on that address becomes a real
membership. Until then the roster lists it under **Invited, no account yet**, where the owner can
withdraw it — which is not the same as removing a member, since there is nobody to keep out. **Rename** names a room, or renames one created without a name. **Make public / Make private**
flips visibility in place — going private also closes every live connection, so anyone who just lost
access has to re-authenticate. **Delete room** is owner-only and asks first; it removes the
whiteboard, the code, the snapshot and the whole update log, and hangs up anyone still connected.

## How it fits together

One HTTP server carries three surfaces:

| Path | Protocol | Purpose |
| --- | --- | --- |
| `/api/v1` | HTTP | Auth, rooms, replay (versioned REST) |
| `/collab` | WebSocket | Hocuspocus — Yjs sync and awareness |
| `/socket.io` | WebSocket | Room lifecycle: join, leave, chat |

Upgrades are routed by pathname in [server/src/index.js](server/src/index.js). In development Vite
proxies all three, so the client uses same-origin relative paths.

### Document model

One `Y.Doc` per room. The server relays and persists; it never owns state.

| Key | Type | Holds |
| --- | --- | --- |
| `shapes` | `Y.Array<Y.Map>` | Whiteboard geometry, one map per shape |
| `code` | `Y.Text` | Monaco buffer, bound via `y-monaco` |
| `meta` | `Y.Map` | Room settings (reserved) |

Shapes are `Y.Map`s rather than plain objects so two people editing different properties of the same
shape merge cleanly. Awareness carries `user` and `cursor` and is never persisted.

Undo is scoped to the whiteboard and, by tracking only the default transaction origin, to **your own
edits** — Ctrl+Z never rolls back a collaborator's work. Monaco keeps its own stack for the code
pane.

### Persistence

Two tiers, in [server/src/collab/persistence.js](server/src/collab/persistence.js):

- **Snapshot** — the full binary state, rewritten on a debounce. Makes loads fast.
- **DocUpdate** — an append-only log, one row per update. Powers replay, and covers anything written
  since the last snapshot if the process dies.

Mutating `DocUpdate` is blocked in [the schema](server/src/models/DocUpdate.js), not merely by
convention. The per-room sequence counter is in-process, which is correct for a single node; more
than one node means moving it to Redis alongside `@hocuspocus/extension-redis`.

## Editing

| Action | How |
| --- | --- |
| Tools | `V` select · `P` freehand · `L` line · `A` arrow · `R` rectangle · `D` diamond · `O` ellipse · `T` text · `E` eraser |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` (also `Ctrl+Y`) |
| Erase | Pick the eraser and drag — it clears everything within about 14px of the pointer, so thin strokes do not need pixel-perfect aim |
| Straight runs | Hold `Shift` while dragging a line or arrow to lock it to 45 degree steps |
| Who drew this | Hover any shape with the select tool — it names the author and when they drew it |
| Delete selection | `Delete` or `Backspace` |
| Run the code | `Ctrl+Enter`, or the Run button in the code pane |
| Everything else | `Ctrl+K` for the command palette, `?` for the shortcut list |
| Zoom | Wheel, anchored at the pointer · reset from the zoom pill |
| Pan | Drag with the select tool |

Tools live in a floating vertical rail on the canvas, with colour, width, and destructive actions
behind popovers, and zoom in a pill at the bottom left. That keeps the rail a fixed 46px wide
whatever the pane width — the earlier single horizontal bar overflowed and clipped its own buttons
as soon as the split moved.

Text is typed inline on the canvas where you clicked. Destructive actions use a real dialog, so
nothing in the app depends on `window.prompt` or `window.confirm`.

Editing while disconnected is allowed on purpose: Yjs queues local changes and merges them on
reconnect. The header shows connection state and a toast reports drops and recoveries.

## Running code

The code pane has a Run button (`Ctrl+Enter`). The server writes the buffer to a throwaway
directory, runs it, and answers with stdout, stderr, the exit code and how long it took. Output
appears in a console under the editor, and the result is broadcast to everyone in the room — a
shared buffer with a private console leaves people guessing why the code they are reading just
printed something.

An `Input` box beside the button is piped to the program's standard input, which is enough for the
usual read-a-line exercises.

| Language | Needs | How it runs |
| --- | --- | --- |
| JavaScript | Node.js | `node main.js` |
| TypeScript | Node.js | Types are stripped, not checked |
| Python | Python 3 | `python -u main.py` |
| Java | JDK 11+ | Single-file source mode, class `Main` |
| C++ | g++ | Compiled with `-std=c++17`, then run |
| Go | Go | `go run main.go` |
| Rust | rustc | Compiled, then run |

Whatever is not installed is reported as unavailable and its Run button says so rather than
failing when pressed. Languages with nothing to execute — SQL, JSON, HTML, CSS, Markdown — can
still be written and shared.

**This runs real programs on the machine hosting the server.** There is no container and no
syscall filter, so the protections are the ones a single process can enforce: a fresh working
directory per run, an environment scrubbed down to a toolchain whitelist (a program cannot read
`MONGODB_URI` or `JWT_SECRET`), a wall-clock timeout that kills the whole process tree, a cap on
captured output, a ceiling on concurrent runs, and a rate limit. Access is the room's: only
someone who can open a room can run its code. Anywhere the people in a room are not people you
trust, set `ALLOW_CODE_EXECUTION=false`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOW_CODE_EXECUTION` | `true` | Turns running off entirely |
| `RUN_TIMEOUT_MS` | `5000` | Wall clock per run; compiles get twice this |
| `RUN_OUTPUT_LIMIT` | `65536` | Bytes of stdout and stderr kept |
| `RUN_MAX_CONCURRENT` | `4` | Programs allowed to run at once |
| `RUN_RATE_LIMIT_MAX` | `60` | Runs per IP per window |

## Interface

Plain CSS, no framework. [client/src/styles](client/src/styles) is layered in dependency order —
`tokens` → `base` → `animations` → `components` → `layout` → `pages` — and `global.css` is only an
`@import` barrel over them, so it stays the single entry point.

Every value comes from a token: a green-biased graphite ramp, one amber accent (the ink you draw
with, so the same colour is the pen, a primary button, and a selected shape's glow), a 4px spacing
scale, and fluid type via `clamp()`. Dark only, deliberately — the canvas and the Monaco theme are
both tuned for it, and the semantic layer is structured so a light theme would be a drop-in rather
than a rewrite.

Below 720px the room stops being a split and becomes one pane at a time behind a segmented control.
Both panes stay **mounted** — the inactive one is hidden with `visibility: hidden`, which keeps it
laid out so the Konva stage and the Monaco model retain their measured size. Unmounting would tear
down the Yjs binding on every switch.

**Two constraints the canvas cannot break.** The eraser end-to-end tests screenshot `.board` and
compare raw pixels, clipping to `x+140 … width-180` and `y+20 … height-130`. So the tool rail must
stay inside the left 140px, the zoom pill inside the bottom 130px, and `.board`'s background must be
completely static — an animated gradient or a fading canvas hint inside that region makes those
tests flake. Both rules are commented where they apply, in
[layout.css](client/src/styles/layout.css).

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness plus database state |
| `POST` | `/api/auth/register` · `/login` | Returns `{ user, token }` |
| `GET` | `/api/auth/me` | Requires bearer token |
| `POST` | `/api/auth/change-password` | Requires bearer token; from the account menu |
| `POST` | `/api/auth/verify-email` | Confirms the address with the emailed token; returns `{ user }` |
| `POST` | `/api/auth/resend-verification` | Requires bearer token; re-issues the email unless already verified |
| `POST` | `/api/rooms` | Creates a private room |
| `GET` | `/api/rooms` | Rooms you own or belong to |
| `GET` | `/api/rooms/:roomId` | Room metadata |
| `PATCH` | `/api/rooms/:roomId` | Owner only; rename or flip public/private |
| `POST` | `/api/rooms/:roomId/invite` | Owner only; by `email` or `userId`. Emails the invitee the room code; answers `{ room, invited }`, where `invited.notified` says whether the relay took it and `invited.pending` says the address has no account yet |
| `DELETE` | `/api/rooms/:roomId/invites/:email` | Owner only; withdraws an invitation to an address that never signed up |
| `DELETE` | `/api/rooms/:roomId/members/:userId` | Owner only; removes someone and keeps them out |
| `DELETE` | `/api/rooms/:roomId/blocked/:userId` | Owner only; undoes a removal |
| `GET` | `/api/rooms/:roomId/people` | Owner and members: roster plus everyone who opened it |
| `DELETE` | `/api/rooms/:roomId` | Owner only; purges the room, snapshot and update log |
| `GET` | `/api/rooms/:roomId/replay` | Timeline metadata; `limit` (≤ 500) and `from` (exclusive seq bound) page through the log |
| `GET` | `/api/rooms/:roomId/replay/:seq` | Binary Yjs state at that point; `X-Updates-Applied` counts the entries folded and `X-Checkpoint-Seq` says which checkpoint the fold started from (0 = the whole log) |
| `POST` | `/api/rooms/:roomId/run` | Runs the buffer and returns its output; result is broadcast to the room |
| `GET` | `/api/runners` | Which languages this machine can run, and whether running is enabled |

The whole surface is also browsable as OpenAPI: Swagger UI at `/docs/`, machine-readable
spec at `/docs/openapi.json`. Both move with `SWAGGER_PATH` and disappear entirely with
`SWAGGER_ENABLED=false` (default: enabled at `/docs`). The docs sit outside `/api/v1`,
so browsing them never spends rate-limit budget.

## Layout

```
client/src
├── api/          client.js — fetch wrapper, token, error normalisation
├── auth/         AuthProvider, useAuth, token storage
├── lib/          collab.js (Y.Doc + provider + undo), monacoSetup, identity, socket,
│                 validation, rooms.js (room helpers + dashboard figures), motion
├── hooks/        useCollabSession, useAwareness, useShapes, useUndo, useElementSize,
│                 useRoomSocket, useDismissable, useCountUp, useMediaQuery
├── store/        uiStore.js — tool, colour, width, zoom, split ratio
├── styles/       tokens · base · animations · components · layout · pages
│                 (global.css is an @import barrel over these)
├── components/   TopBar, UserMenu, RoomCard, SplitPane, ProductPreview, dialogs,
│                 Whiteboard/ (ToolRail, CanvasControls, TextComposer), Editor/,
│                 ui/ (Button, Field, Icon, Modal, Segmented, Skeleton, StatCard, …)
└── pages/        Home, Login, Register, Dashboard, Room, NotFound

server/src
├── config/       env.js (zod-validated), cors.js (shared origin policy), logger.js
├── models/       User, Room, Snapshot, DocUpdate (append-only)
├── services/       auth, room, replay, verification · email
├── routes/       auth.routes.js, rooms.routes.js
├── middleware/   auth, validate, error
├── collab/       hocuspocus.js, persistence.js
├── realtime/     socket.js
└── index.js      HTTP server + upgrade routing + shutdown
```

## Tests

```bash
npm test                      # server, 158 tests
npm test --workspace client   # client, 42 tests
npm run test:e2e              # browser, two real tabs, 3 tests
```

The server suite runs against a real in-memory MongoDB, not mocks: env validation, the REST API and
its access control, replay reconstruction, append-only enforcement, Socket.io room lifecycle, and —
in [server/test/collab.test.js](server/test/collab.test.js) — two live clients proving edits
propagate both ways, that simultaneous writes to the same offset converge without loss, and that a
room reloads from MongoDB after every client leaves.

The client suite covers the API wrapper, session restore and sign-out, the toast system, the account
menu, the UI store's clamping, and registration validation.

The Playwright suite in [e2e/sync.spec.js](e2e/sync.spec.js) drives two real browser tabs against
the running stack: both must see each other in presence, code typed in one must appear in the other
and back again, a rectangle drawn in one must change the other's canvas pixels, and the tool rail
must not overflow at 1440, 1100, or 900px wide. It needs a MongoDB; start one of the three ways
above first.

## Continuous integration

Every push to `main` or `feature/frontend`, and every pull request, runs
`.github/workflows/ci.yml`: lint, unit tests and the production build for the
client, and lint plus the full unit suite for the server. The two run as
separate jobs, so a failure names the side it came from.

Node 20 rather than the newest release — `package.json` asks for `>=20`, and the
floor is the version worth proving the code still runs on. The server job caches
`~/.cache/mongodb-binaries`, because most of that suite starts an in-process
MongoDB and `mongodb-memory-server` otherwise downloads a ~100 MB `mongod` on
every run.

A third job drives the Playwright suite: it starts both servers itself and
takes a real browser through the app — two tabs syncing a room, drawing,
erasing, running code, the dashboard. It caches the browser as well as the
MongoDB binary, and keeps the trace as an artifact when it fails, because a
browser failure is close to unreadable without one.

Those run with one retry on CI and none locally. They drive two real browsers
against two real servers, so a timing loss is not the same event as a broken
feature — but a test that needs the retry every time is one to fix, and the run
summary names the ones that used it.

## What "production ready" would still take

The app is solid for a demo or an internal tool. Before putting it in front of untrusted users:

- **Token storage.** The JWT sits in `localStorage`, which any injected script can read. Moving to an
  httpOnly, SameSite cookie plus a short-lived access token and refresh rotation is the real fix, and
  it changes how the WebSocket handshake authenticates.
- **No refresh tokens.** Sessions last `JWT_EXPIRES_IN` (7d default) and cannot be revoked before
  they expire. There is no logout-everywhere and no server-side session list.
- **Transport.** Serve over HTTPS/WSS behind a proxy, set HSTS, and tighten the helmet CSP — the
  defaults here are permissive enough for Vite's dev server.
- **Observability.** pino logs to stdout with no aggregation, tracing, or alerting, and the error
  boundary logs to the console instead of a reporter.
- **Update-log growth.** One insert per Yjs update, so a fast typist writes a lot of rows. Batching,
  compaction, or a TTL is needed before this runs long-term; `PERSIST_UPDATE_LOG=false` disables it
  (and replay with it).
- **Checkpoint growth.** Each checkpoint is a full copy of the document and the document grows with
  the log, so at a fixed interval their total size goes as O(n² / interval) while the log goes as
  O(n). At 250 they came to 79 KB against a 60 KB log in the benchmark, which is fine; over a much
  longer life they would not be. Thinning the old ones — keeping a bounded number by widening the
  spacing as the room ages — is what makes a smaller interval affordable, and is not done here.
- **Single node.** See the sequence-counter note above.
- **Replay reach.** The viewer pages the log but stops at 5,000 entries and says so — past that,
  a scrubber has finer pixels than steps and each one is a round trip. Coarser positions (one per
  second of wall-clock, say) would be needed to replay a long-lived room end to end.
- **Monaco bundle** is 3.3 MB (857 kB gzipped) because every language ships. Trim the language set
  when size matters.

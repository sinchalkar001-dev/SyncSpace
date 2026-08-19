# SyncSpace

Real-time collaborative whiteboard and code editor. Two people open the same room and draw on a
shared canvas while editing a shared code buffer — concurrent edits merge through CRDTs rather than
last-write-wins.

Rooms sync live, survive a server restart, and can be replayed from an append-only log.

## Stack

**Client** — React 18 · Vite 6 · Yjs · `@hocuspocus/provider` · react-konva · Monaco + `y-monaco` ·
Zustand · React Router · socket.io-client

**Server** — Node 20+ ESM · Express 4 · `@hocuspocus/server` + `ws` · Socket.io · MongoDB + Mongoose ·
JWT + bcryptjs · zod · pino · helmet / cors / rate-limit

## Running it

```bash
npm install
npm run dev:server    # http://localhost:4000
npm run dev:client    # http://localhost:5173
```

**MongoDB.** The server expects `mongodb://127.0.0.1:27017/syncspace`. Three ways to get one:

| Situation | Command |
| --- | --- |
| MongoDB installed locally | nothing — it is the default |
| Docker available | `docker compose up -d` |
| Neither | `npm run dev:memory --workspace server` |

`dev:memory` boots the server against a throwaway in-memory MongoDB. Everything written is lost on
exit — it is for trying things out, not for keeping work.

Other scripts: `npm test`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Accounts and access

Two ways in, both first-class:

- **Signed in** — register or sign in, get a JWT, and keep a dashboard of your rooms. Rooms you
  create are private and invite-only.
- **Guest** — open a room link and pick a display name. Guests reach public rooms only.

Guest access is deliberate: the interview scenario in the brief needs a candidate to join from a
link without signing up. The server enforces the same rule the UI shows, and refuses to boot in
production with `ALLOW_ANONYMOUS=true`.

Sign out lives in the account menu at the top right of both the dashboard and any room. It clears
the token, drops you back to a guest identity, and reconnects the room with the new credentials.

Each room on the dashboard has its own menu. **People** shows the owner and invited members
alongside everyone who has actually opened the room — guests included, since they are recorded by
visit rather than by invitation. **Delete room** is owner-only and asks first; it removes the
whiteboard, the code, the snapshot and the whole update log, and hangs up anyone still connected.

## How it fits together

One HTTP server carries three surfaces:

| Path | Protocol | Purpose |
| --- | --- | --- |
| `/api` | HTTP | Auth, rooms, replay |
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
| Tools | `V` select · `P` pen · `R` rectangle · `O` ellipse · `T` text · `E` eraser |
| Undo / redo | `Ctrl+Z` / `Ctrl+Shift+Z` (also `Ctrl+Y`) |
| Delete selection | `Delete` or `Backspace` |
| Zoom | Wheel, anchored at the pointer · reset from the zoom pill |
| Pan | Drag with the select tool |

Tools live in a floating vertical rail on the canvas, with colour, width, and destructive actions
behind popovers, and zoom in a pill at the bottom left. That keeps the rail a fixed 48px wide
whatever the pane width — the earlier single horizontal bar overflowed and clipped its own buttons
as soon as the split moved.

Text is typed inline on the canvas where you clicked. Destructive actions use a real dialog, so
nothing in the app depends on `window.prompt` or `window.confirm`.

Editing while disconnected is allowed on purpose: Yjs queues local changes and merges them on
reconnect. The header shows connection state and a toast reports drops and recoveries.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness plus database state |
| `POST` | `/api/auth/register` · `/login` | Returns `{ user, token }` |
| `GET` | `/api/auth/me` | Requires bearer token |
| `POST` | `/api/rooms` | Creates a private room |
| `GET` | `/api/rooms` | Rooms you own or belong to |
| `GET` | `/api/rooms/:roomId` | Room metadata |
| `POST` | `/api/rooms/:roomId/invite` | Owner only |
| `GET` | `/api/rooms/:roomId/people` | Owner and members: roster plus everyone who opened it |
| `DELETE` | `/api/rooms/:roomId` | Owner only; purges the room, snapshot and update log |
| `GET` | `/api/rooms/:roomId/replay` | Timeline metadata |
| `GET` | `/api/rooms/:roomId/replay/:seq` | Binary Yjs state at that point |

## Layout

```
client/src
├── api/          client.js — fetch wrapper, token, error normalisation
├── auth/         AuthProvider, useAuth, token storage
├── lib/          collab.js (Y.Doc + provider + undo), monacoSetup, identity, socket, validation
├── hooks/        useCollabSession, useAwareness, useShapes, useUndo, useElementSize, useRoomSocket
├── store/        uiStore.js — tool, colour, width, zoom, split ratio
├── components/   Whiteboard/ (ToolRail, CanvasControls, TextComposer), Editor/, ui/, UserMenu
└── pages/        Home, Login, Register, Dashboard, Room, NotFound

server/src
├── config/       env.js (zod-validated), logger.js
├── models/       User, Room, Snapshot, DocUpdate (append-only)
├── services/     auth, room, replay
├── routes/       auth.routes.js, rooms.routes.js
├── middleware/   auth, validate, error
├── collab/       hocuspocus.js, persistence.js
├── realtime/     socket.js
└── index.js      HTTP server + upgrade routing + shutdown
```

## Tests

```bash
npm test                      # server, 53 tests
npm test --workspace client   # client, 31 tests
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
- **Single node.** See the sequence-counter note above.
- **Replay UI.** The endpoints exist; the scrubber does not.
- **Monaco bundle** is 3.3 MB (857 kB gzipped) because every language ships. Trim the language set
  when size matters.

# SyncSpace

Real-time collaborative whiteboard and code editor. Two people open the same room and draw on a
shared canvas while editing a shared code buffer — concurrent edits merge through CRDTs rather than
last-write-wins.

Frontend and backend are both in place. Rooms sync live, survive a server restart, and can be
replayed from an append-only log.

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

Open the client, create a room, and paste the URL into a second window.

**MongoDB.** The server expects `mongodb://127.0.0.1:27017/syncspace`. Three ways to get one:

| Situation | Command |
| --- | --- |
| MongoDB installed locally | nothing — it is the default |
| Docker available | `docker compose up -d` |
| Neither | `npm run dev:memory --workspace server` |

`dev:memory` boots the server against a throwaway in-memory MongoDB. Everything written is lost on
exit — it is for trying things out, not for keeping work.

Other scripts: `npm test`, `npm run lint`, `npm run build`.

## How it fits together

One HTTP server carries three surfaces:

| Path | Protocol | Purpose |
| --- | --- | --- |
| `/api` | HTTP | Auth, rooms, replay |
| `/collab` | WebSocket | Hocuspocus — Yjs sync and awareness |
| `/socket.io` | WebSocket | Room lifecycle: join, leave, chat |

Upgrades are routed by pathname in [server/src/index.js](server/src/index.js); Socket.io keeps its
own listener and Hocuspocus gets everything on `/collab`. In development Vite proxies all three, so
the client uses same-origin relative paths.

### Document model

One `Y.Doc` per room. The server relays and persists; it never owns state.

| Key | Type | Holds |
| --- | --- | --- |
| `shapes` | `Y.Array<Y.Map>` | Whiteboard geometry, one map per shape |
| `code` | `Y.Text` | Monaco buffer, bound via `y-monaco` |
| `meta` | `Y.Map` | Room settings (reserved) |

Shapes are `Y.Map`s rather than plain objects so two people editing different properties of the same
shape merge cleanly. Awareness carries `user` and `cursor` and is never persisted.

### Persistence

Two tiers, in [server/src/collab/persistence.js](server/src/collab/persistence.js):

- **Snapshot** — the full binary state, rewritten on a debounce. Makes loads fast.
- **DocUpdate** — an append-only log, one row per update. Powers replay, and covers anything written
  since the last snapshot if the process dies.

Loading applies the snapshot, then replays log entries recorded after it. Mutating `DocUpdate` is
blocked in [the schema](server/src/models/DocUpdate.js), not merely by convention.

The per-room sequence counter is in-process, which is correct for a single node. Running more than
one node means moving it to Redis alongside `@hocuspocus/extension-redis`.

### Auth

`POST /api/auth/register` and `/login` return a JWT. The token is passed to Hocuspocus and Socket.io,
which verify it in `onAuthenticate` and a connection middleware.

Rooms opened by URL are created on demand and are **public**, so ad-hoc sessions work without an
account. Rooms created through `POST /api/rooms` are **private** and invite-only. Guests are admitted
only while `ALLOW_ANONYMOUS=true`; the env schema refuses to boot in production with it enabled, or
without a 32-character `JWT_SECRET`.

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
| `GET` | `/api/rooms/:roomId/replay` | Timeline metadata |
| `GET` | `/api/rooms/:roomId/replay/:seq` | Binary Yjs state at that point |

## Layout

```
client/src
├── lib/          collab.js (Y.Doc + provider), monacoSetup.js, identity.js, socket.js, env.js
├── hooks/        useCollabSession, useAwareness, useShapes, useElementSize, useRoomSocket
├── store/        uiStore.js — tool, colour, width, zoom, split ratio
├── components/   Whiteboard/, Editor/, SplitPane, PresenceBar, ConnectionStatus
└── pages/        Home (create/join), Room (split view)

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
npm test        # 53 tests
```

Backed by a real in-memory MongoDB, not mocks. Covers env validation, the REST API and its access
control, replay reconstruction, append-only enforcement, Socket.io room lifecycle, and — in
[server/test/collab.test.js](server/test/collab.test.js) — two live clients proving edits propagate
both ways, that simultaneous writes to the same offset converge without loss, and that a room
reloads from MongoDB after every client leaves.

## Known gaps

- **Replay UI** — the backend endpoints exist; the client scrubber does not.
- **Update log cost** — one insert per Yjs update, so a fast typist writes a lot of rows. Batching or
  a TTL is the next step; `PERSIST_UPDATE_LOG=false` disables it (and replay with it).
- **Text placement** uses `window.prompt`. An inline canvas input would be better.
- **Monaco bundle** is 3.3 MB (857 kB gzipped) because every language ships. Trim the language set
  when size matters.
- **Single node only** — see the sequence-counter note above.

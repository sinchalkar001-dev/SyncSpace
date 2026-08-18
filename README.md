# SyncSpace

Real-time collaborative whiteboard and code editor. Two people open the same room and draw on a
shared canvas while editing a shared code buffer — concurrent edits merge through CRDTs rather than
last-write-wins.

This branch contains the **frontend only**. The backend is not built yet; see
[Backend contract](#backend-contract) for the interface this client expects.

## Stack

| Concern | Choice |
| --- | --- |
| App shell | React 18 + Vite 6 (JavaScript) |
| Shared state | Yjs (CRDT) — source of truth for both panes |
| Transport | `@hocuspocus/provider` over WebSocket |
| Canvas | `react-konva` + Konva |
| Editor | `@monaco-editor/react` + `y-monaco` |
| Local UI state | Zustand |
| Routing | React Router 6 |
| Room lifecycle | `socket.io-client` (wired, gated off — see below) |

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

Other scripts: `npm run build`, `npm run preview`, `npm run lint`.

The client starts and renders without a backend. The connection pill in the header will sit at
**Offline** and nothing persists, but the UI, tools, and editor are all usable locally.

## Layout

```
client/src
├── lib/
│   ├── collab.js         Y.Doc + Hocuspocus provider; shape helpers
│   ├── monacoSetup.js    Monaco workers, local loader, dark theme
│   ├── identity.js       Local display name + stable per-user colour
│   ├── socket.js         Socket.io client factory (room lifecycle)
│   └── env.js            API / collab / socket endpoint resolution
├── hooks/
│   ├── useCollabSession.js   Provider lifecycle, status, sync state
│   ├── useAwareness.js       Peer list + throttled cursor broadcast
│   ├── useShapes.js          Y.Array -> React state
│   └── useElementSize.js     ResizeObserver for the Konva stage
├── store/uiStore.js      Zustand: tool, colour, width, zoom, split ratio
├── components/
│   ├── Whiteboard/       Stage, shape nodes, toolbar, remote cursors
│   ├── Editor/           Monaco pane bound to Yjs
│   ├── SplitPane.jsx     Draggable divider
│   ├── PresenceBar.jsx   Avatar stack
│   └── ConnectionStatus.jsx
└── pages/                Home (create/join), Room (split view)
```

## Document model

One `Y.Doc` per room. The server relays and persists updates; it never owns state.

| Key | Type | Holds |
| --- | --- | --- |
| `shapes` | `Y.Array<Y.Map>` | Whiteboard geometry, one map per shape |
| `code` | `Y.Text` | Monaco buffer, bound via `y-monaco` |
| `meta` | `Y.Map` | Room settings (reserved) |

Shapes are `Y.Map`s rather than plain objects so two people editing different properties of the same
shape merge cleanly instead of clobbering each other.

Awareness (ephemeral, never persisted) carries `user` (`{ id, name, color }`) and `cursor`
(`{ x, y }` in document coordinates). Cursor updates are throttled to 40ms.

## What works

- Split-screen room at `/room/:roomId`, draggable divider, create/join from `/`
- Whiteboard: freehand, rectangle, ellipse, text, eraser, select/move
- Wheel zoom anchored at the pointer, drag-to-pan, zoom reset
- Live peer cursors with name badges, drawn at constant screen size across zoom levels
- Monaco bound to `Y.Text`, with per-peer remote selection colours and name labels
- Presence avatars and a connection/sync indicator
- Keyboard: `V P R O T E` select tools, `Delete` removes selection, `Esc` deselects
  (scoped to the canvas so it never hijacks typing in the editor)

## Not done yet

- **Auth** — `token` is sent to Hocuspocus as the literal string `anonymous`. JWT lands in week 4.
- **Replay** — the week 4 scrubber needs the backend's append-only update log.
- **Room lifecycle over Socket.io** — the client factory exists but the hook is gated behind
  `VITE_ENABLE_ROOM_SOCKET=true` so it does not sit in a reconnect loop against a server that is not
  there. Flip it on once the backend serves `/socket.io`.
- **Text placement** uses `window.prompt`. Works, but an inline canvas input is the better UX.
- **Monaco bundle** is 3.3 MB (857 kB gzipped) because every language ships. Trimming the language
  set is the easy win when bundle size starts to matter.

## Backend contract

The client expects one HTTP server exposing three things. Dev requests are proxied by
`client/vite.config.js` to `http://localhost:4000` (override with `VITE_BACKEND_ORIGIN`).

| Path | Protocol | Purpose |
| --- | --- | --- |
| `/collab` | WebSocket | Hocuspocus server; document name is the room id |
| `/socket.io` | WebSocket | Room lifecycle: `room:join`, `room:leave` |
| `/api` | HTTP | Auth, room metadata, replay timeline |

Copy `client/.env.example` to `client/.env` to point at a non-default backend.

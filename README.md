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

### Roles

Six of them. Each grants everything the one below it does, plus more:

| Role | Adds |
| --- | --- |
| **Viewer** | Read the room and its history |
| **Commenter** | Chat |
| **Runner** | Run the code, without being able to change it |
| **Editor** | Draw, edit code, upload and delete files, generate from the whiteboard |
| **Admin** | Room settings, invite and remove people, assign roles below their own |
| **Owner** | Delete the room, transfer it, appoint admins |

**Runner** is the one worth explaining. An editor could always run code, so a separate role only
earns its place by granting execution *without* editing — which is the interview case this room was
built for: a candidate runs the tests, and the buffer stays as the interviewer left it.

Roles are set from the same roster panel, in a dropdown beside each name. It offers only what the
server said you may hand out, and the server checks again regardless.

### How it is enforced

One module — [server/src/permissions.js](server/src/permissions.js) — answers every authorization
question in the system. Not for tidiness: a permission system with two implementations has one
implementation and one hole, and the hole is always the surface nobody remembered.

There are four such surfaces, and only one of them is REST:

| Where | What stops you |
| --- | --- |
| REST | `requirePermission` on the route, before the handler runs |
| **Yjs document** | The connection is opened **read-only** for anybody without edit rights |
| Socket.io | Checked on join, and again on every chat message |
| Files, execution | The capability, checked in the service rather than the route |

The Yjs one is the load-bearing one. The whiteboard and the code buffer never travel over REST —
they are Yjs updates on a WebSocket — so every REST guard could be perfect and a viewer would still
be able to rewrite the room. Hocuspocus drops their updates rather than closing the connection, so
a viewer stays connected, keeps seeing everyone else's edits, and simply cannot contribute any.

Demoting somebody who is connected closes their document connection, because a connection outlives
the permission that opened it: read-only is decided at the handshake, so without that they would
keep writing until they happened to reconnect.

### Privilege escalation

Three rules, compared by rank rather than listed as forbidden pairs — a list needs revisiting every
time a role is added:

- You cannot grant a role at or above your own.
- You cannot change anybody at or above your own rank.
- Only an owner deals in admins, in either direction.

Ownership is never granted through role assignment. It moves by transfer, one deliberate act, and
the previous owner stays on as an admin.

The invitation endpoint is bound by the same rules. That is not obvious and it matters: being
allowed to invite is not the same as being allowed to invite *at any rank*, and without the check
an admin who cannot promote a member to admin could simply invite a fresh account as one.

### Guests

A public room still lets anyone who opens the link draw on it — that is what `guestRole` defaults
to, because quietly demoting every existing guest to read-only would break rooms that work today.
An owner who wants "anyone may watch, nobody may touch" can now say so.

Whatever the guest role, anything that permanently names a person or changes who may enter needs an
account: uploading files, generating from the whiteboard, inviting, assigning roles, room settings.
A guest identity is a display name typed into a box, which is not something to hang either on.

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

**Forgotten passwords.** "Reset it" on the sign-in page emails a link, valid for one hour and good
for a single use; it opens a page to choose a new password and signs you in once it is saved.
Asking again replaces the previous link.

Three details are deliberate. The endpoint answers the same `{ sent: true }` whether or not the
address has an account — saying otherwise would turn a public, unauthenticated route into a way to
test which addresses are registered here — so the screen can only ever say *if* that address has an
account. It also answers *before* looking the address up: a registered address costs a document
write that an unregistered one does not, and a response that waited for it would have a duration
carrying the answer the body refuses to give. And a successful reset marks the address verified,
because reading the email is the same proof `/verify-email` asks for.

**A reset ends every session on the account**, which matters most here: the reason someone resets a
password they cannot remember is often that somebody else can, and a reset that left the intruder
signed in would be the appearance of security rather than security. A fresh session is opened
immediately after, so the person resetting stays signed in.

## Signed-in devices

**Account menu → Signed-in devices.** Every browser holding a session for the account, named from
its User-Agent, with where it signed in from and when it was last used. The row you are reading it
on is marked **This device** and has no sign-out button — without the marker the list is a row of
indistinguishable browsers, and with the button it would be the likeliest misclick in the dialog.
Any other row can be signed out on its own, or **Sign out all other devices** ends the lot.

Signing a device out takes effect immediately, not at the next page load: its live document and
presence connections are closed on the spot, so it stops being able to type on a whiteboard as well
as stopping being able to call the API.

How it works, since a signed JWT cannot be withdrawn. Each session is a row; the token carries its
`jti` and every authenticated request follows that back to the row. Revoking is deleting it — there
is no `revoked` flag to forget to filter on, and the IP address stops being held the moment the
session ends. The check runs at all four doors a token can arrive at (both REST guards, the collab
handshake, the socket handshake), and rows expire themselves through a TTL index so the collection
cannot grow forever. The cost is one read on a unique index per authenticated request, and none at
all for a request carrying no token, which is every guest.

The shape of that record is what decides the feature: a single marker on the account can revoke
everything at once but cannot *name* the sessions, so "what is signed in?" and "sign out that one"
have no answer. A row each answers both.

> **Deploy note.** A token issued before sessions were recorded names no row, so it is refused
> rather than grandfathered — accepting it would leave tokens that "sign out all other devices"
> cannot reach, which is the hole the feature exists to close. Deploying therefore signs everyone
> out once.

**What is stored, and for how long.** The raw `User-Agent` and the IP address, per session, visible
only to the account itself. Both are kept deliberately — "somewhere I do not recognise" is the whole
reason anyone opens this list — and both are deleted with the row when the session ends or expires.
`req.ip` follows Express's `trust proxy`; behind a load balancer without it set, every session
records the balancer's address instead, which is useless rather than misleading.

## Email verification

A new account is created **unverified**, and the only thing that changes that is confirming the
address. Not a valid-looking address, not a successful sign-up, and not the frontend saying so —
the backend is the source of truth and nothing else writes `emailVerified`.

The confirmation email carries **two proofs**, because they suit different situations. The link is
one tap on whatever device holds the mailbox. The six-digit code is what you use when the email is
on your phone and SyncSpace is open on a laptop — the alternative there is retyping a 64-character
token, which nobody does.

They are not the same secret and are not treated as one:

| | Link | Code |
| --- | --- | --- |
| Size | 256 bits | six digits |
| Expiry | 30 minutes | 10 minutes |
| Attempts | unlimited — it cannot be guessed | 5, then it burns |
| Compared | by hash lookup | in constant time |

Running out of attempts **burns the code outright** rather than merely refusing it. Leaving it live
would hand the guesses back to whoever triggers the next resend, and the limit would buy nothing.
Only hashes are stored, so a database leak cannot be replayed against either.

Resending replaces both, resets the attempt budget, and is held behind a cooldown — that cooldown
is what stops the button being a way to mail-bomb an address, and it lives on the account rather
than in memory so it survives a restart and holds across every server process.

**Signing in with an unverified address** depends on `REQUIRE_EMAIL_VERIFICATION`, which is off by
default. Turning it on locks out every account that has not verified yet, including every one
created before verification was enforced, so it is a deliberate act once the people who need to
verify have had the chance. The refusal comes *after* the password check: answering
`email_not_verified` to a wrong password would confirm the address has an account, which is exactly
what `bad_credentials` is worded to avoid.

## Room invitations

An invitation used to be a row saying "this address is expected". That is enough to let somebody in
when they sign up and nothing else — it could not expire, could not be used once, and could not be
told apart from a guess at an address. A room invited to in March was still standing in December.

Invitations now carry a hashed, expiring, single-use token, and the property that makes it worth
having is that it is **bound**: to the room, and to the address it was sent to. A forwarded
invitation is not a way into somebody else's room.

Four things must hold to accept one, and each closes something specific:

- the token resolves — otherwise it is expired, spent or invented
- the account's address matches the one invited
- that address has been verified
- the person has not been removed from the room since

Accepting removes the invitation, so a second attempt finds nothing: single-use here is an absence,
not a flag some later query could forget to filter on. A mismatched address answers the same 404 as
an unknown token, because saying which address it was meant for is exactly what the binding
protects.

**Whether an invitation is claimed automatically** depends on the same setting. With verification
not required, signing up from an invitation puts you in the room, as it always has — there is
nothing to bypass, and removing the convenience would only add a step. With verification required,
the invitation waits and is redeemed by presenting the token. That asymmetry is deliberate: an
invitation can only bypass verification where verification means something, and auto-claiming a
tokened invitation would consume it, leaving the person to follow the link in their email and be
told it was invalid — spent by something they never did.

Invitations sent before tokens existed have nothing to present, so they are still claimed on
sign-up. Without that, everybody holding one would have been stranded by the upgrade.

**Outgoing mail.** Four things are sent: the verification email, the password reset link, a room
invitation, and the relay check. All come from one sender identity — `MAIL_FROM_NAME` and
`MAIL_FROM_EMAIL` — because a relay only accepts a From it recognises. With no relay configured all
are written to the server log instead, which is all development needs.

Templates live in [email.templates.js](server/src/services/email.templates.js), separate from the
sending, because copy and infrastructure change for different reasons and by different people. Each
is HTML plus plain text: the text part is not a courtesy, a message without one is scored as spam by
most filters, and the one thing these emails cannot afford is to be filed as junk.

`EMAIL_PROVIDER=mock` composes every message and sends none, keeping the last few where a test can
read the code out of one — which is how the suite checks verification without scraping log output.
It is **refused in production**: a deployment that silently stopped sending mail would look
perfectly healthy right up until nobody could sign in.

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
| `MAIL_FROM_NAME` | `SyncSpace` | Display name on every message |
| `MAIL_FROM_EMAIL` | `SMTP_USER` | The one address SyncSpace sends as |
| `MAIL_FROM` | *(derived)* | The older single-field form. Still read, and still wins when set, so an existing deployment keeps working |
| `EMAIL_PROVIDER` | `smtp` | `mock` composes and sends nothing. Refused in production |
| `CLIENT_URL` | first `CORS_ORIGIN` | Absolute origin the emailed links point at |
| `EMAIL_VERIFICATION_TOKEN_EXPIRY_MINUTES` | `30` | Life of the emailed link |
| `EMAIL_VERIFICATION_CODE_EXPIRY_MINUTES` | `10` | Life of the six-digit code — shorter, because it is guessable |
| `EMAIL_VERIFICATION_MAX_ATTEMPTS` | `5` | Wrong codes before the code is burned outright |
| `EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS` | `60` | Wait between verification emails |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Whether an unverified account may sign in. Turning it on locks out everyone not yet verified |
| `INVITATION_EXPIRY_HOURS` | `168` | How long a room invitation stays acceptable |

**Keeping credentials out of the repository.** A gitignore only lists the mistakes somebody already
thought of — `server/uploads/` was missing from it until a test run staged the files it had written
there. So `scripts/scan-secrets.js` looks at what is actually about to be committed: it refuses any
`.env` by name, and refuses content matching the shapes that are unambiguous (Google `AIza…`,
Anthropic `sk-ant-…`, AWS, GitHub, Slack, private-key blocks, JWTs), plus any long opaque value
assigned to a `KEY`/`SECRET`/`TOKEN`/`PASSWORD` name inside an env file.

It runs two places. `npm install` points `core.hooksPath` at `.githooks/`, so the pre-commit hook is
versioned and reviewable rather than living unversioned in `.git/hooks` — and CI runs the same scan
over every tracked file, because a hook lives on one machine and `--no-verify` is one flag away.
A deliberate fixture can carry `secret-scan: allow` on its line or the one above it. Run it by hand
with `npm run scan:secrets`.

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

A run that is queued or still going says so, and offers **Cancel** — to whoever started it, and to
the room's owner, who otherwise has no way to end somebody else's program in their own room short
of waiting out the timeout.

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

### How a run happens

```
Client  →  POST /rooms/:id/run  →  execution job  →  queue  →  isolated runner
                                                                     ↓
Room broadcast  ←  execution record  ←  result  ←  sandbox (container per run)
```

The queue is the part that is not obvious. Admission is checked before anything becomes a
process — per person, per room, and against the queue's own depth — so one person with a script
gets a slower turn rather than every slot in the building. A run is given an id and announced to
the room as `execution:state` the moment it is queued, which is what makes it cancellable: until
the room knows the name of something still running, there is nothing anyone can press Cancel on.

Each run is recorded with its id, room, who started it, the language, a SHA-256 of the source, the
times, the exit code, the output and **why it ended**. States are `queued`, `running`, `completed`,
`failed`, `timed_out`, `resource_limit` and `cancelled`; `termination` is finer, because
`resource_limit` covers memory, output and process ceilings, which a person would fix three
different ways. Records expire on their own — program output is whatever somebody typed into a
shared editor.

### The sandbox

With a container runtime, each run gets its own container and nothing survives it:

| Control | How |
| --- | --- |
| Network | `--network none`. Nothing, including the cloud metadata endpoint that hands out credentials |
| Memory | `--memory` with `--memory-swap` equal, so swap is not the way around it |
| CPU | `--cpus` |
| Processes | `--pids-limit`, which is the whole answer to a fork bomb |
| Filesystem | `--read-only` plus a size-capped `--tmpfs`; only the run's own directory is writable |
| Privileges | `--cap-drop ALL`, `--security-opt no-new-privileges`, never root |
| Disk | `--ulimit fsize`, so the bind mount cannot be filled |
| Environment | Docker passes none of the server's; only `HOME` and toolchain caches are added back |
| Cleanup | The container is removed on every path, and orphans are labelled so they can be reaped |

Two more hold whatever the backend: output is **capped and the program killed**, rather than left
to burn a core printing into the bin; and host paths are stripped from stdout and stderr before
anyone sees them. That last one is not cosmetic — an uncaught error in Node names the file it was
running by its real path, which spells out the OS, the account the server runs as, and where its
temporary files live, to everyone in the room.

### Deployment

```sh
cd server
npm run sandbox:pull     # fetch the images; the first run of a language is otherwise a silent download
npm run sandbox:check    # what this machine would really do with somebody else's program
```

A container runtime with **no images pulled** does not count as available, and that is not a
corner case — it is every CI runner and every laptop where Docker arrived with the operating
system. `docker run` on a missing image is a silent download, which against a five-second
execution budget is not a run but a timeout, on every language at once, with nothing in the
message about images. `auto` falls back to the process backend and says why; `docker` refuses and
names the fix. Either way, run `sandbox:pull` at deploy.

Set **`SANDBOX_BACKEND=docker` in production.** The default is `auto`, which falls back to running
programs as ordinary child processes when no container runtime answers — right for a laptop, wrong
for a host anyone else can reach, and quiet about it either way. `docker` refuses to run code at
all rather than run it unsandboxed. `npm run sandbox:check --strict` exits non-zero when anything
is unenforced, which makes it a deploy gate.

The server needs access to the Docker socket, and the working directory is bind-mounted into the
container — so on Docker-in-Docker or a rootless daemon, check that `SANDBOX_USER` can write to it.

### What it does not do

The process backend **is not a sandbox** and nothing here pretends otherwise. It enforces a
timeout, an output cap, a throwaway working directory and a scrubbed environment — the four things
one Node process can impose on a child that is otherwise its peer. A program running under it can
read any file the server account can read, open any socket, allocate until the machine swaps, and
fork until the process table is full. The security tests assert exactly this, empirically, rather
than asserting a protection that is not there.

Which controls are real is reported by `GET /api/v1/runners` and shown next to the console, because
"read the deployment's environment variables" is not an answer available to the person in the room
about to run a stranger's code.

Even with containers: this is isolation, not a proof. A container shares the host kernel, so a
kernel exploit is a way out — `SANDBOX_RUNTIME=runsc` puts gVisor underneath if that matters. And
`ALLOW_CODE_EXECUTION=false` is still the only setting that runs nothing at all.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOW_CODE_EXECUTION` | `true` | Turns running off entirely |
| `SANDBOX_BACKEND` | `auto` | `docker`, `process`, or `auto`. Production wants `docker` |
| `SANDBOX_MEMORY_MB` | `256` | Memory ceiling per run |
| `SANDBOX_CPUS` | `1` | CPU ceiling per run |
| `SANDBOX_PIDS` | `64` | Process ceiling per run |
| `SANDBOX_FILE_SIZE_MB` | `32` | Largest file a program may write, and the `/tmp` size |
| `SANDBOX_NETWORK` | `false` | Whether the container gets a network at all |
| `SANDBOX_USER` | server's uid | Who the program is inside the container; never root |
| `SANDBOX_RUNTIME` | — | Passed to `--runtime`, for gVisor or Kata |
| `SANDBOX_IMAGES` | — | Per-language image overrides, as one JSON object |
| `SANDBOX_MAX_PER_USER` | `2` | Runs one person may have queued or running |
| `SANDBOX_MAX_PER_ROOM` | `4` | Runs one room may have queued or running |
| `SANDBOX_QUEUE_DEPTH` | `32` | How many may wait before the server says no |
| `SANDBOX_RETENTION_HOURS` | `24` | How long a run's output is kept |
| `RUN_TIMEOUT_MS` | `5000` | Wall clock per run; compiles get twice this |
| `RUN_OUTPUT_LIMIT` | `65536` | Bytes of stdout and stderr kept before the program is killed |
| `RUN_MAX_CONCURRENT` | `4` | Programs allowed to run at once |
| `RUN_RATE_LIMIT_MAX` | `60` | Runs per IP per window |
| `SANDBOX_CANCEL_RATE_LIMIT_MAX` | `120` | Cancellations per IP per window, budgeted separately |

## Presence

Everyone in a room is shown with what they are doing and where they are doing it:

```
Sinchal     ● Editing Main.java     Line 42
Manideep    ● Drawing               Whiteboard
Ayush       ● Idle
Reviewer    ○ Offline
```

The dot is active, idle (a minute without input) or away (the tab is hidden); invited
members who are not connected read as offline. The file is the name the buffer runs
under — `Main.java`, `main.py` — because there is one shared buffer rather than a tree of
files, and inventing a file browser to populate this line would be decoration. On the
board, the shapes somebody has selected are outlined in their colour with their name,
so two people do not reshape the same box without knowing it.

**Follow** moves your board and your editor with somebody else's, and switches to split
view if they move to the half you have hidden. It ends when you press Esc, touch the
board, zoom, type, or click in the editor — the way grabbing a wheel ends cruise control —
and ends itself, with a message, if they leave or stop sharing. **Go to** is a single
jump to wherever somebody is: the line their caret is on, else the shapes they have
selected, else their pointer.

### What it costs

Presence rides on Yjs awareness, which re-sends a client's *whole* state every time any
field changes. So the frequent field is kept apart from the rare one, and nothing is sent
that has not changed:

| Field | Sent when | At most |
| --- | --- | --- |
| `cursor` | the pointer moves on the board | ~15/s (66ms), rounded to whole units, repeats dropped |
| `presence` | what you are doing, or where, actually changes | 4/s (250ms) |
| `view` | **only while somebody is following you** | ~8/s (120ms) |

The pointer used to go out every 40ms. It now goes out every 66ms and the receiving side
eases each cursor toward its latest sample on every animation frame, which looks smoother
than 25 raw positions did — a cursor that jumps to each sample is jerky at any rate. The
frame loop runs only while a cursor is still moving, so a quiet room costs no frames.

Typing a hundred characters on one line sends the presence field once. A follower
announces who it follows, and a client sends its viewport only while somebody says they
are following it, so a room where nobody follows anybody sends no viewports at all. The
people list re-renders when somebody's status changes, not when their pointer moves.
These numbers are asserted in `useAwareness.test.jsx` and `usePresence.test.jsx` against
real awareness instances, not mocks.

### Privacy and permissions

- Presence reaches only connections the server admitted to the room. Somebody refused a
  private room sees nobody's name, caret or selection — `presence-isolation.test.js`
  holds the transport to that.
- **Share my activity** (the eye beside your own name) keeps your line, selection,
  pointer and viewport on your machine — they are never sent, rather than sent and
  hidden. You read as simply online, cannot be followed, and anybody following you is
  let go with a message. The choice is remembered per browser.
- What is sent is coarse on purpose: the line, never the column or the selected text;
  shape ids, never their contents.
- Presence is self-reported. A client clamps its own report by its capabilities, so a
  viewer is never announced as editing — but a modified client could claim anything, and
  that is acceptable only because a claim is just a label. What somebody can actually
  change is enforced by the read-only Yjs connection, and a test proves a viewer claiming
  to edit writes nothing.

### Presence is not history

Hocuspocus applies awareness to `document.awareness` and never to the document, so none
of this can reach the update log, a snapshot, replay or the activity feed. That is
structural rather than a convention, and `presence-isolation.test.js` holds it there: a
burst of every presence field writes nothing, while one character typed on the same
connections is recorded — which is what makes the silence mean something.

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

## Whiteboard to code

Draw a system on the board — boxes with labels, arrows between them — and ask for an
implementation. The **⚡ button** in the room header opens it.

**It reads the diagram, not a screenshot.** That distinction is the feature. The whiteboard stores
drawings, not diagrams: an arrow is four numbers, and a label is an unrelated `text` shape that
happens to sit on top of a box. Nothing records that the arrow between "API" and "Database" *means*
anything. So the graph is recovered geometrically — arrows resolve to the nearest box at each end,
text inside a box becomes its label, text on a line becomes that connection's relationship — and the
result is an explicit list of components, connections and notes.

```
[Client]  ->  [API]  ->  [Auth Service]  ->  [Database]
```

becomes

| | |
| --- | --- |
| **nodes** | `client` (client), `api` (api), `auth-service` (auth), `database` (datastore) |
| **edges** | `client → api`, `api → auth-service`, `auth-service → database` |

Component types are inferred from the label and the shape (`database`/`store` → data store,
`queue`/`kafka` → queue, a diamond → decision), which is a hint for the model and something for you
to correct — not a rule anything depends on.

**The reading is shown before anything is generated.** It is inference and it is sometimes wrong,
and the right answer to a misread diagram is fixing the diagram. The panel also lists what the
diagram *could not* say — an arrow that reaches nothing, a box nobody labelled, two boxes with the
same name — and those go to the model as gaps rather than being guessed at. `GET /api/rooms/:id/architecture`
returns exactly this, and involves no model at all.

**What comes back is a proposal, never a write.** The model returns a plan, a set of whole files,
the assumptions it had to make, and the questions the diagram left open. Then:

- **`create` and `modify` are decided by the server**, not taken from the answer. The model has
  never seen the room's files, so its "create" means "I wrote a new file" — not "this path is free",
  which it is in no position to claim. Anything landing on a name the room already has becomes a
  modification, and arrives carrying the current contents so the change can be read. That is the
  whole of *do not blindly overwrite*: nothing is replaced that was not first shown.
- **Every path is checked.** Absolute paths, `..`, backslashes, null bytes and oversized files are
  refused and reported rather than repaired — silently rewriting `../../etc/passwd` into something
  harmless would hide that it was proposed.
- **Nothing is applied until you tick it.** Accept some, reject the rest; what you leave unticked is
  recorded as rejected rather than left undecided. Accepted files are written into the room's files
  through the same upload path as any other, so the same permissions apply.

Generation needs an account (it spends a real request and is recorded against whoever asked) and
room access. Every run — including failures — is kept as the room's **AI timeline**, and both
generating and applying are announced to everyone in the room over the socket.

**Switching it on.** Set one key in `server/.env` — `ANTHROPIC_API_KEY=sk-ant-…`
([console](https://console.anthropic.com/settings/keys)) or `GOOGLE_API_KEY=AIza…`
([AI Studio](https://aistudio.google.com/apikey)). Which service gets called is worked out from the
shape of the key, so there is no second setting to keep in step with it; `AI_PROVIDER` overrides the
guess for a gateway whose keys look like neither. Both are driven through their function-calling
APIs so the answer arrives as structured arguments rather than prose that has to be dug out of a
paragraph — one code path, either vendor.

Model defaults to `claude-sonnet-5` or `gemini-3.6-flash`. Note that Google's older `2.5` names are
still listed by its models endpoint but are closed to new keys, and answer a 404 that reads like the
model does not exist.

Without a key the panel says so and the architecture reading still works, because that needs no
model at all.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness plus database state |
| `POST` | `/api/auth/register` · `/login` | Returns `{ user, token }` |
| `GET` | `/api/auth/me` | Requires bearer token |
| `POST` | `/api/auth/change-password` | Requires bearer token; ends every session and returns `{ user, token }` — the replacement must be adopted |
| `GET` | `/api/auth/sessions` | Devices signed in to your account; `current` marks the caller |
| `DELETE` | `/api/auth/sessions` | Signs out every device except this one; answers `{ revoked }` |
| `DELETE` | `/api/auth/sessions/:sessionId` | Signs out one device and closes its live connections |
| `POST` | `/api/auth/verify-email` | Confirms the address with the emailed token; returns `{ user }` |
| `POST` | `/api/auth/resend-verification` | Requires bearer token; re-issues the email unless already verified |
| `POST` | `/api/auth/forgot-password` | Emails a reset link. Always answers `{ sent: true }`, registered or not — and answers before looking the address up, so the timing says nothing either |
| `POST` | `/api/auth/reset-password` | Spends the emailed token and sets a new password; returns `{ user, token }` |
| `POST` | `/api/rooms` | Creates a private room; optional `description` and `kind` |
| `GET` | `/api/rooms` | Rooms you own or belong to |
| `GET` | `/api/rooms/:roomId` | Room metadata |
| `PATCH` | `/api/rooms/:roomId` | Owner or admin; `name`, `description`, `kind` and `isPublic`, any subset. `kind` is one of `general`, `coding`, `interview`, `system-design` |
| `PUT` | `/api/rooms/:roomId/preferences` | Pins or archives the room **for the caller only**; `{ pinned?, archived? }`, either alone. Requires only that you can see the room |
| `GET` | `/api/rooms/:roomId/activity` | What has happened in this room, newest first; same access rule as reading it |
| `GET` | `/api/activity` | The dashboard feed: the same events across every room you belong to |
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
| `GET` | `/api/ai` | Whether this server can generate code, why not if it cannot, and what it can be asked for |
| `GET` | `/api/rooms/:roomId/architecture` | The system design read off the whiteboard: nodes, edges, notes, and what could not be read. No model involved |
| `POST` | `/api/rooms/:roomId/generate` | Turns the diagram into a proposed change set. Writes nothing |
| `GET` | `/api/rooms/:roomId/generations` | The room's AI timeline, newest first, failures included |
| `GET` | `/api/rooms/:roomId/generations/:id` | One change set in full, with every proposed file |
| `POST` | `/api/rooms/:roomId/generations/:id/apply` | Accepts the named files and records the rest as rejected |

### The dashboard, and what it is built on

Three things had to exist on the server before a room list could be a workspace rather
than a wall of names.

**A room can say what it is.** `description` and `kind` are room fields, so everyone who
opens the room agrees about them. `kind` is a fixed set of four rather than free tags,
because it exists to answer one question — which of these forty is the system design one
— and a tag cloud answers that worse than a short list. `general` means unclassified, not
miscellaneous, and every room that predates the field is one.

**Pinning and archiving are opinions, not properties.** They live in their own collection
keyed by `(user, roomId)` and are never visible to anybody else. Two people sharing an
interview room will not agree on which of their rooms belongs at the top, and a room one
of them has finished with is still live work for the other — so neither can be a field on
the room without one collaborator silently rearranging everybody else's dashboard. A
missing row is the default and the common case, so nothing is written until somebody
actually pins or archives something.

**Activity is recorded where it happens.** `Activity` rows are written from the execution
service when a run finishes, from `recordParticipant` on somebody's first visit, from the
chat handler, and from a Yjs `afterTransaction` listener for edits. It is deliberately
lossy: rows expire after 30 days, and continuous editing is collapsed in memory to at
most one row per person per room per minute, so a hot typing path costs nothing.

Three details in there are load-bearing and invisible from the outside:

- The whiteboard and the code buffer are two shared types on **one** Yjs document, so an
  update alone does not say which was touched. The transaction does: every changed type
  is either `code`/`shapes` or nested inside one, and walking up to the root names the
  half of the room that moved.
- Attribution is not guesswork. Hocuspocus applies a client's update with the connection
  as the Yjs origin, and a connection carries the context `onAuthenticate` returned, so
  `transaction.origin.context.user` is the person who typed.
- The listener is attached in `afterLoadDocument`, **after** the snapshot and update log
  have been replayed. Attached any earlier, opening a room would announce that everybody
  in it had just edited everything.

Chat is broadcast and never stored, so a `comment.added` event records that a
conversation happened and deliberately not what was said. Losing the whole collection
costs the dashboard a panel and costs the rooms nothing.

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
└── pages/        Home, Login, Register, VerifyEmail, ForgotPassword, ResetPassword,
                  Dashboard, Room, NotFound

server/src
├── config/       env.js (zod-validated), cors.js (shared origin policy), logger.js
├── models/       User, Session (one per signed-in device), Room, Snapshot,
│                 DocUpdate (append-only), Generation (one change set)
├── services/     auth, room, replay, verification, password-reset, session,
│                 architecture (whiteboard -> graph), ai (graph -> proposal),
│                 generation (orchestration + apply) · email
├── utils/        token.js — hashed single-use email secrets, and session ids
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
- **No refresh tokens.** Sessions last `JWT_EXPIRES_IN` (7d default) and cannot be extended without
  signing in again, so a working session simply stops after a week. Revocation itself is solved —
  each session is a row that can be listed and deleted — but the short-lived-access-token plus
  rotation design is what the httpOnly-cookie move above would want, and it would let a stolen token
  be useful for minutes rather than days.
- **Session rows are per-node truth only in one respect.** The rows themselves are in MongoDB and
  shared, so revoking works across processes. Hanging up *live* connections does not: it walks the
  Hocuspocus documents and Socket.io sockets held by the process that served the request, so on a
  multi-node deployment the signed-out device's websocket on another node stays open until it next
  reconnects. Redis adapters for both would close that gap; see the single-node note above.
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

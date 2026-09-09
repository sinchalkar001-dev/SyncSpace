import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const pkg = require('../../package.json')

/**
 * The REST surface, hand-written rather than generated from annotations:
 * the spec stays reviewable as code and the routes themselves carry none of
 * it. Paths are written from the server root (health sits outside /api/v1),
 * and `servers` is relative so Try-it-out always calls the host serving
 * this document.
 *
 * Every response shape here mirrors what the services actually return —
 * user.toPublic(), room.toPublic(), listPeople() — not an idealised version.
 */

/** Shorthand for the shared error envelope every non-happy path returns. */
const error = (status, description, code, message) => ({
  [status]: {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/Error' },
        example: { error: { code, message } },
      },
    },
  },
})

const validationError = () => error(400, 'Body failed schema validation', 'validation_failed', 'email: invalid email')
/**
 * Two codes share this status. `unauthorized` means the token was missing,
 * malformed or expired; `session_revoked` means it was a real session that has
 * since been ended by a password change or reset, and is worth telling apart
 * because the answer to it is "sign in again", not "something went wrong".
 */
const authRequired = () =>
  error(
    401,
    'Missing, malformed or expired bearer token (`unauthorized`), or a session ended by a password change or reset (`session_revoked`)',
    'unauthorized',
    'A valid bearer token is required'
  )
const rateLimited = (message) => error(429, 'Per-IP rate budget exhausted; see RateLimit headers', 'rate_limited', message)

export const openapiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'SyncSpace API',
    version: pkg.version,
    description: [
      'Collaborative whiteboards and code editing rooms.',
      '',
      'Three surfaces share one process:',
      '',
      '- **REST** (`/api/v1`, documented here) — accounts, rooms, invitations, replay.',
      '- **Collab** (`/collab`) — Yjs document sync over WebSocket via Hocuspocus.',
      '- **Socket.io** (`/socket.io`) — room lifecycle events such as `code:run` broadcasts.',
      '',
      'The WebSocket surfaces are out of scope of this document.',
    ].join('\n'),
  },

  servers: [{ url: '/', description: 'Same host that serves this document' }],

  tags: [
    { name: 'Health', description: 'Liveness and database state' },
    { name: 'Auth', description: 'Registration, login, password change, email verification' },
    { name: 'Users', description: 'Reading account data — your own profile and room rosters' },
    { name: 'Rooms', description: 'Creating, finding, renaming, publishing and deleting rooms' },
    { name: 'Invitations', description: 'Granting and withdrawing access to a room' },
    { name: 'Replay', description: 'Timeline metadata and historical document state' },
    { name: 'Code execution', description: 'Running a room buffer and discovering runnable toolchains' },
    { name: 'AI', description: 'Reading a system design off the whiteboard and generating an implementation from it' },
  ],

  security: [{ bearerAuth: [] }],

  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness probe',
        description: 'Answers 200 only while MongoDB is reachable; load balancers should treat 503 as unhealthy.',
        security: [],
        responses: {
          200: {
            description: 'Healthy',
            content: {
              'application/json': {
                example: { status: 'ok', db: 'connected', uptime: 1234 },
              },
            },
          },
          503: {
            description: 'Database disconnected',
            content: {
              'application/json': {
                example: { status: 'degraded', db: 'disconnected', uptime: 1234 },
              },
            },
          },
        },
      },
    },

    '/api/v1/auth/register': {
      post: {
        tags: ['Auth'],
        summary: 'Create an account',
        description:
          'Returns a bearer token immediately. A verification email is queued; with no SMTP configured the link is logged instead of sent.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterInput' } } },
        },
        responses: {
          201: {
            description: 'Account created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AuthSession' },
              },
            },
          },
          ...validationError(),
          ...error(409, 'The email is already registered', 'email_taken', 'That email is already registered'),
          ...rateLimited('Too many sign-up attempts from this address, try again later'),
        },
      },
    },

    '/api/v1/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange credentials for a token',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginInput' } } },
        },
        responses: {
          200: {
            description: 'Authenticated',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } },
          },
          ...validationError(),
          ...error(401, 'Unknown email or wrong password — indistinguishable by design', 'bad_credentials', 'Incorrect email or password'),
          ...rateLimited('Too many login attempts, try again later'),
        },
      },
    },

    '/api/v1/auth/me': {
      get: {
        tags: ['Auth', 'Users'],
        summary: 'Your profile',
        responses: {
          200: {
            description: 'The signed-in user',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } },
              },
            },
          },
          ...authRequired(),
          ...error(404, 'Account deleted after the token was issued', 'user_not_found', 'User not found'),
        },
      },
    },

    '/api/v1/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate your password',
        description:
          'Ends every session opened under the old password — on this account only — and answers ' +
          'a replacement. The new token must be adopted: the one used to make this call is among ' +
          'the sessions it just ended.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangePasswordInput' } } },
        },
        responses: {
          200: {
            description: 'Password changed, other sessions ended, replacement session issued',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } },
          },
          ...validationError(),
          ...authRequired(),
          ...error(401, 'Current password does not match', 'bad_password', 'Current password is incorrect'),
          ...rateLimited('Too many password changes, try again later'),
        },
      },
    },

    '/api/v1/auth/verify-email': {
      post: {
        tags: ['Auth'],
        summary: 'Confirm an email address',
        description: [
          'Public: whichever proof arrived is the authorisation. Send **either** the token from the link **or** the six-digit code from the same email.',
          '',
          'They are not equivalent secrets. The token is 256 bits, so holding it is proof on its own and it only needs an expiry. The code is a million combinations, so it is accepted only against a named account — by session when there is one, otherwise by `email` — expires sooner, and is bounded by an attempt count.',
          '',
          'Running out of attempts burns the code outright rather than merely refusing it: leaving it live would hand the guesses back to whoever triggers the next resend.',
        ].join('\n'),
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/VerifyEmailInput' } } },
        },
        responses: {
          200: {
            description: 'Address verified',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } },
              },
            },
          },
          ...validationError(),
          ...{
            400: {
              description:
                'The proof did not work. `invalid_token` for a link, `invalid_code` for a wrong code (the message says how many attempts remain), `code_expired` once the code has aged out.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  examples: {
                    invalid_token: {
                      summary: 'Link unknown, expired or already used',
                      value: { error: { code: 'invalid_token', message: 'This verification link is invalid or has expired' } },
                    },
                    invalid_code: {
                      summary: 'Wrong code, with the budget left',
                      value: { error: { code: 'invalid_code', message: 'That code is not right — 3 attempts left' } },
                    },
                    code_expired: {
                      summary: 'Code aged out',
                      value: { error: { code: 'code_expired', message: 'That verification code has expired — ask for a new one' } },
                    },
                  },
                },
              },
            },
          },
          ...error(409, 'Nothing left to verify', 'already_verified', 'This account is already verified'),
          ...{
            429: {
              description:
                'Either the per-IP verification budget (`rate_limited`) or this code’s attempt budget (`too_many_attempts`), which burns the code and requires a resend.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  examples: {
                    too_many_attempts: {
                      summary: 'Guessing budget spent',
                      value: { error: { code: 'too_many_attempts', message: 'Too many incorrect codes. Ask for a new verification email.' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      get: {
        tags: ['Auth'],
        summary: 'Follow the link from the email',
        description: [
          'Where the button in the verification email points. A GET so it works from any mail client, and a redirect rather than JSON because a person following a link expects a page.',
          '',
          'The outcome travels in the query string (`?status=verified` or `?status=invalid`) so the client can render the right state without a second round trip. The token is deliberately **not** carried through to the destination, where it would land in browser history.',
          '',
          'Every failure redirects to the same `invalid` — which of expired, spent or unknown it was is in the server log, not the URL.',
        ].join('\n'),
        security: [],
        parameters: [
          {
            name: 'token',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          302: {
            description: 'Redirects to the client with the outcome in `status`.',
            headers: {
              Location: { schema: { type: 'string', example: 'http://localhost:5173/verify-email?status=verified' } },
            },
          },
        },
      },
    },

    '/api/v1/auth/verification-status': {
      get: {
        tags: ['Auth'],
        summary: 'What the check-your-email screen renders from',
        description:
          'The address is masked (`a***@example.com`): enough to recognise, not enough to publish on a shared screen. `retryAfter` is the resend cooldown still to run, and `attemptsLeft` the guessing budget on the current code.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Verification state',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    email: { type: 'string', example: 'a***@example.com' },
                    emailVerified: { type: 'boolean' },
                    emailVerifiedAt: { type: ['string', 'null'], format: 'date-time' },
                    retryAfter: { type: 'integer', description: 'Seconds before another email may be requested' },
                    codeExpiresAt: { type: ['string', 'null'], format: 'date-time' },
                    attemptsLeft: { type: ['integer', 'null'] },
                  },
                },
              },
            },
          },
          ...authRequired(),
        },
      },
    },

    '/api/v1/ai': {
      get: {
        tags: ['AI'],
        summary: 'Whether this server can generate code from a whiteboard',
        description:
          'A sibling of `/runners`: reachability of a model is a property of the deployment, not ' +
          'of a room. `enabled` is false with a readable `reason` when no key is configured or the ' +
          'feature is switched off. Never reports the key itself.',
        security: [],
        responses: {
          200: {
            description: 'Generation availability and the targets that can be asked for',
            content: {
              'application/json': {
                example: {
                  enabled: true,
                  model: 'claude-sonnet-5',
                  reason: null,
                  targets: [{ key: 'backend', description: 'Server-side services and business logic' }],
                },
              },
            },
          },
        },
      },
    },

    '/api/v1/auth/sessions': {
      get: {
        tags: ['Auth'],
        summary: 'Devices signed in to your account',
        description:
          'One entry per live session, newest first. `current` marks the one making the request. ' +
          '`userAgent` is the raw header — turning it into "Chrome on Windows" is presentation. ' +
          'Visible only to the account itself.',
        responses: {
          200: {
            description: 'The account\'s live sessions',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    sessions: { type: 'array', items: { $ref: '#/components/schemas/Session' } },
                  },
                },
              },
            },
          },
          ...authRequired(),
        },
      },
      delete: {
        tags: ['Auth'],
        summary: 'Sign out every other device',
        description:
          'Ends every session on the account except the one making the request, and closes their ' +
          'live document and presence connections. Answers how many were ended. The current ' +
          'session is deliberately kept: signing it out is what the sign-out button does.',
        responses: {
          200: {
            description: 'Sessions ended',
            content: { 'application/json': { example: { revoked: 2 } } },
          },
          ...authRequired(),
          ...rateLimited('Too many sign-out requests, try again later'),
        },
      },
    },

    '/api/v1/auth/sessions/{sessionId}': {
      delete: {
        tags: ['Auth'],
        summary: 'Sign out one device',
        description:
          'Ends a single session and closes its live connections. Reaches only the caller\'s own ' +
          'sessions: an id belonging to somebody else answers 404, exactly as an unknown one does.',
        parameters: [
          {
            name: 'sessionId',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
          },
        ],
        responses: {
          200: {
            description: 'Session ended',
            content: { 'application/json': { example: { revoked: 1 } } },
          },
          ...error(400, 'Not a session id', 'bad_session_id', 'That is not a session id'),
          ...authRequired(),
          ...error(404, 'No such live session on this account', 'session_not_found', 'That session is not signed in'),
          ...rateLimited('Too many sign-out requests, try again later'),
        },
      },
    },

    '/api/v1/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Ask for a password reset link',
        description:
          'Always answers `{ sent: true }`, whether or not the address belongs to an account — ' +
          'a different answer would turn this into a way to test which addresses are registered. ' +
          'The emailed link lasts 60 minutes and can be used once; asking again invalidates the ' +
          'previous one. With no SMTP configured the link is logged instead of sent.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ForgotPasswordInput' } } },
        },
        responses: {
          200: {
            description: 'Request processed (`sent` means processed, not delivered, and not that the account exists)',
            content: { 'application/json': { example: { sent: true } } },
          },
          ...validationError(),
          ...rateLimited('Too many password reset emails requested, try again later'),
        },
      },
    },

    '/api/v1/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Set a new password with an emailed token',
        description:
          'Public: the token is the authorisation. Consumed on first use, and it verifies the ' +
          'address as a side effect, since reading the email proves the same control ' +
          '`/verify-email` asks for. Answers a session, so there is no need to sign in again. ' +
          'Tokens issued before the reset stay valid until they expire — there is no global ' +
          'revocation, exactly as for `/change-password`.',
        security: [],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ResetPasswordInput' } } },
        },
        responses: {
          200: {
            description: 'Password changed and signed in',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthSession' } } },
          },
          ...validationError(),
          ...error(400, 'Token unknown, expired or already used', 'invalid_token', 'This reset link is invalid or has expired'),
          ...rateLimited('Too many password reset attempts, try again later'),
        },
      },
    },

    '/api/v1/auth/resend-verification': {
      post: {
        tags: ['Auth'],
        summary: 'Re-issue the verification email',
        responses: {
          200: {
            description: 'Email handed to the mailer (`sent` means processed, not delivered)',
            content: { 'application/json': { example: { sent: true } } },
          },
          ...authRequired(),
          ...error(404, 'Account no longer exists', 'user_not_found', 'User not found'),
          ...error(409, 'Nothing to do — the address is already verified', 'already_verified', 'This account is already verified'),
          ...rateLimited('Too many verification emails requested, try again later'),
        },
      },
    },

    '/api/v1/rooms': {
      post: {
        tags: ['Rooms'],
        summary: 'Create a room',
        description: 'Rooms made through the API are private and owned by their creator; ad-hoc rooms opened by URL are public.',
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomCreateInput' } } },
        },
        responses: {
          201: {
            description: 'Room created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomEnvelope' } } },
          },
          ...authRequired(),
        },
      },
      get: {
        tags: ['Rooms'],
        summary: 'List your rooms',
        description: 'Rooms you own or are a member of, most recently active first, capped at 50.',
        responses: {
          200: {
            description: 'Room summaries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    rooms: { type: 'array', items: { $ref: '#/components/schemas/Room' } },
                  },
                },
              },
            },
          },
          ...authRequired(),
        },
      },
    },

    '/api/v1/rooms/{roomId}': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      get: {
        tags: ['Rooms'],
        summary: 'Read room metadata',
        description: 'Readable by anyone while public; members and the owner once private. Anonymous callers allowed while ALLOW_ANONYMOUS is on.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Room metadata',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomEnvelope' } } },
          },
          ...error(403, 'Private room and you are not a member', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
      patch: {
        tags: ['Rooms'],
        summary: 'Rename or flip visibility',
        description: 'Owner only. Going private closes live collab connections so anyone who just lost access must re-authenticate.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomUpdateInput' } } },
        },
        responses: {
          200: {
            description: 'Updated room',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomEnvelope' } } },
          },
          ...validationError(),
          ...authRequired(),
          ...error(403, 'Only the owner may change a room', 'not_owner', 'Only the room owner can change this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
      delete: {
        tags: ['Rooms'],
        summary: 'Delete a room and its history',
        description: 'Owner only. Purges the snapshot, update log and participant records; live connections are hung up first.',
        responses: {
          200: {
            description: 'Deleted, with the number of log entries removed',
            content: {
              'application/json': { example: { roomId: 'aB3xYk9Q', deletedUpdates: 128 } },
            },
          },
          ...authRequired(),
          ...error(403, 'Only the owner may delete a room', 'not_owner', 'Only the room owner can delete this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/preferences': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      put: {
        tags: ['Rooms'],
        summary: 'Pin or archive a room, for yourself',
        description: [
          'A preference, not a property. Two people sharing a room will not agree on which of their rooms belongs at the top, and a room one of them has finished with is still live work for the other - so neither pin nor archive is stored on the room, and neither is visible to anybody else.',
          '',
          'Idempotent: pinning an already pinned room succeeds. Requires only that you can see the room.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomPreferenceInput' } } },
        },
        responses: {
          200: {
            description: 'The preference as it now stands',
            content: {
              'application/json': {
                example: { preference: { roomId: 'aB3xYk9Q', pinned: true, archived: false } },
              },
            },
          },
          ...validationError(),
          ...authRequired(),
          ...error(403, 'Not a room you can see', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/activity': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      get: {
        tags: ['Rooms'],
        summary: 'What has happened in this room',
        description: [
          'Newest first. Recorded where each thing happens rather than derived afterwards, and deliberately lossy: rows expire after 30 days, and continuous editing is collapsed to at most one row per person per minute.',
          '',
          'Chat is broadcast and never stored, so a comment event records that a conversation happened and never what was said.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'How many to return, newest first (1-100).',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Newest first',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    activity: { type: 'array', items: { $ref: '#/components/schemas/Activity' } },
                  },
                },
              },
            },
          },
          ...error(403, 'Private room and you are not a member', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/activity': {
      get: {
        tags: ['Rooms'],
        summary: 'Recent activity across your rooms',
        description:
          'The dashboard feed. Your room list is resolved first and the events are read from those ids, so this can never report on a room you are no longer in.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'How many to return, newest first (1-100).',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Newest first, across every room you belong to',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    activity: { type: 'array', items: { $ref: '#/components/schemas/Activity' } },
                  },
                },
              },
            },
          },
          ...authRequired(),
        },
      },
    },

    '/api/v1/rooms/{roomId}/people': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      get: {
        tags: ['Users', 'Rooms'],
        summary: 'Roster of a room',
        description:
          'Owner, invited members, anyone the owner removed, and everyone who actually opened the room. Owned rooms show this only to owner and members. Participants are ordered by most recent visit and capped at the latest 100.',
        responses: {
          200: {
            description: 'Roster',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/PeopleRoster' } },
            },
          },
          ...authRequired(),
          ...error(403, 'Roster visible to members only', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/invite': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      post: {
        tags: ['Invitations'],
        summary: 'Invite a user to a room',
        description:
          'Owner only. Identify the invitee by userId or by email — exactly one of the two. Inviting someone already in the room succeeds without changing their role, and inviting someone who was removed lifts that removal. Every successful invite emails the invitee the room code and a link to the room, so repeating one is also how an owner re-sends it. An address nobody has signed up with is held on the room and emailed an invitation to create an account; it becomes a real membership the moment one exists, and until then it is reported as pending and listed by the roster. A userId that matches nobody is still a 404, since an id can only ever mean an existing account.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InviteInput' } } },
        },
        responses: {
          200: {
            description: 'Membership recorded (idempotent) and the invitation sent',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    room: { $ref: '#/components/schemas/Room' },
                    invited: { $ref: '#/components/schemas/Invited' },
                  },
                },
              },
            },
          },
          ...validationError(),
          ...authRequired(),
          ...error(403, 'Only the owner can invite people', 'not_owner', 'Only the room owner can invite people'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
          ...rateLimited('Too many invites sent, try again later'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/invites/{email}': {
      parameters: [
        { $ref: '#/components/parameters/roomId' },
        {
          name: 'email',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'email' },
          description: 'The invited address, URL-encoded.',
        },
      ],
      delete: {
        tags: ['Invitations'],
        summary: 'Withdraw an invitation that was never taken up',
        description:
          'Owner only. Stops an address with no account being expected. Not the same as removing a member: there is no account to put out and nobody to keep away, so nothing is recorded against them and a later invite is an ordinary invite.',
        responses: {
          200: {
            description: 'The invitation is withdrawn',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    room: { $ref: '#/components/schemas/Room' },
                    cancelled: {
                      type: 'object',
                      properties: { email: { type: 'string', format: 'email' } },
                    },
                  },
                },
              },
            },
          },
          ...authRequired(),
          ...error(403, 'Only the owner can withdraw an invitation', 'not_owner', 'Only the room owner can remove people'),
          ...error(404, 'No invitation is waiting for that address', 'invite_not_found', 'No invitation is waiting for that address'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/transfer': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      post: {
        tags: ['Invitations'],
        summary: 'Hand the room to somebody else',
        description: [
          'Owner only, and separate from role assignment on purpose: ownership carries the three powers an admin is deliberately denied — deleting the room, transferring it, and appointing admins — so moving it is one explicit act rather than a value in a dropdown.',
          '',
          'The previous owner stays on as an admin. The recipient must already be a member.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['userId'],
                properties: { userId: { type: 'string', pattern: '^[0-9a-f]{24}$' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Ownership moved',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    room: { $ref: '#/components/schemas/Room' },
                    people: { $ref: '#/components/schemas/PeopleRoster' },
                  },
                },
              },
            },
          },
          ...validationError(),
          ...error(403, 'Only the owner may transfer a room', 'not_owner', 'Only the room owner can transfer this room'),
          ...error(404, 'The recipient is not in this room', 'not_a_member', 'That person is not in this room'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/members/{userId}': {
      parameters: [
        { $ref: '#/components/parameters/roomId' },
        { $ref: '#/components/parameters/userId' },
      ],
      patch: {
        tags: ['Invitations'],
        summary: 'Change what somebody may do in a room',
        description: [
          'Owner or admin. The role decides every capability the person has — see the `Role` schema for what each one grants.',
          '',
          'Two refusals, and the difference matters. `not_owner` means you do not deal in roles at all. `role_forbidden` means you do, but not *that* role for *that* person: you may never grant a role at or above your own, never change somebody at or above your own rank, and only an owner deals in admins. Ownership is not assignable here — it moves by transfer.',
          '',
          'Demoting somebody who is connected closes their document connection so they reconnect read-only; a promotion between two editing roles does not interrupt them.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['role'],
                properties: { role: { $ref: '#/components/schemas/AssignableRole' } },
              },
            },
          },
        },
        responses: {
          200: {
            description: 'Role changed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    room: { $ref: '#/components/schemas/Room' },
                    people: { $ref: '#/components/schemas/PeopleRoster' },
                  },
                },
              },
            },
          },
          ...validationError(),
          ...{
            403: {
              description:
                'Either you cannot manage roles here at all (`not_owner`), or you can but not this one (`role_forbidden`) — the escalation rules above.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  examples: {
                    not_owner: {
                      summary: 'Not an owner or admin',
                      value: { error: { code: 'not_owner', message: 'Only the room owner or an admin can remove people' } },
                    },
                    role_forbidden: {
                      summary: 'An admin trying to appoint another admin',
                      value: { error: { code: 'role_forbidden', message: 'You cannot give somebody that role' } },
                    },
                  },
                },
              },
            },
          },
          ...error(400, 'The owner’s role moves by transfer', 'cannot_demote_owner', 'The owner’s role is changed by transferring the room'),
          ...error(404, 'Not a member of this room', 'not_a_member', 'That person is not in this room'),
        },
      },
      delete: {
        tags: ['Invitations'],
        summary: 'Remove someone from a room',
        description:
          'Owner only. Drops the membership and records the person as removed, so a public room cannot let them straight back in through its link; a later invite lifts it. Their live document and presence connections close immediately, and their visit history is cleared.',
        responses: {
          200: {
            description: 'Membership withdrawn',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    room: { $ref: '#/components/schemas/Room' },
                    removed: { $ref: '#/components/schemas/Member' },
                  },
                },
              },
            },
          },
          ...error(400, 'The owner cannot be removed from their own room', 'cannot_remove_owner', 'The room owner cannot be removed'),
          ...authRequired(),
          ...error(403, 'Only the owner can remove people', 'not_owner', 'Only the room owner can remove people'),
          ...error(404, 'No room under that id, or no such user', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/blocked/{userId}': {
      parameters: [
        { $ref: '#/components/parameters/roomId' },
        { $ref: '#/components/parameters/userId' },
      ],
      delete: {
        tags: ['Invitations'],
        summary: 'Undo a removal',
        description:
          'Owner only, and idempotent. Lets a removed person open the room again on its normal terms — a private room still needs an invite.',
        responses: {
          200: {
            description: 'Removal lifted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomEnvelope' } } },
          },
          ...authRequired(),
          ...error(403, 'Only the owner can remove people', 'not_owner', 'Only the room owner can remove people'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/replay': {
      parameters: [
        { $ref: '#/components/parameters/roomId' },
        {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Maximum timeline entries returned, clamped to 500.',
          schema: { type: 'integer', minimum: 1, maximum: 500, default: 500 },
        },
        {
          name: 'from',
          in: 'query',
          required: false,
          description:
            'Exclusive lower bound on `seq`. Pass the last seq of the previous page to read the next one; the log is append-only, so pages never shift.',
          schema: { type: 'integer', minimum: 0, default: 0 },
        },
      ],
      get: {
        tags: ['Replay'],
        summary: 'Document update timeline',
        description:
          'Metadata for a replay scrubber — never payloads. Requires PERSIST_UPDATE_LOG=true, otherwise refused. Public rooms are readable anonymously, like room metadata.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Chronological entries',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    timeline: { type: 'array', items: { $ref: '#/components/schemas/TimelineEntry' } },
                  },
                },
              },
            },
          },
          ...error(400, 'The server is not persisting the update log', 'replay_disabled', 'Replay is disabled (PERSIST_UPDATE_LOG=false)'),
          ...error(403, 'Private room and you are not a member', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/replay/{seq}': {
      parameters: [
        { $ref: '#/components/parameters/roomId' },
        {
          name: 'seq',
          in: 'path',
          required: true,
          description: 'Fold every logged update up to and including this sequence number.',
          schema: { type: 'integer', minimum: 0 },
        },
      ],
      get: {
        tags: ['Replay'],
        summary: 'Binary document state at a point in time',
        description:
          'A Yjs update stream ready for `Y.applyUpdate`. Reads start from the newest stored checkpoint at or before `seq` rather than folding the log from the beginning, so `X-Updates-Applied` counts only the entries folded on top of it and `X-Checkpoint-Seq` says which one that was (0 = the whole log). Public rooms are readable anonymously, like room metadata.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Raw Yjs state',
            headers: {
              'X-Updates-Applied': {
                description:
                  'Log entries folded on top of the checkpoint to produce this state — the work this request actually did, not the number of entries the state represents',
                schema: { type: 'integer' },
              },
              'X-Checkpoint-Seq': {
                description:
                  'Sequence number of the checkpoint the fold started from, or 0 if the whole log was folded',
                schema: { type: 'integer' },
              },
            },
            content: {
              'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
            },
          },
          ...error(400, 'seq must be a non-negative integer', 'bad_seq', 'seq must be a non-negative integer'),
          ...error(403, 'Private room and you are not a member', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/architecture': {
      get: {
        tags: ['AI'],
        summary: 'The system design read off the whiteboard',
        description:
          'The whiteboard stores drawings, not diagrams: an arrow is four numbers and a label is ' +
          'an unrelated text shape sitting on a box. This recovers the graph geometrically — ' +
          'components, connections, notes — and reports in `warnings` what the diagram could not ' +
          'express. No model is involved. Read it before generating: the answer to a misread ' +
          'diagram is fixing the diagram.',
        parameters: [{ $ref: '#/components/parameters/roomId' }],
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'The architecture graph',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { architecture: { $ref: '#/components/schemas/Architecture' } },
                },
              },
            },
          },
          ...error(403, 'Not a member of a private room', 'room_forbidden', 'You do not have access to this room'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/generate': {
      post: {
        tags: ['AI'],
        summary: 'Turn the whiteboard into a proposed change set',
        description:
          'Reads the architecture from the server\'s own copy of the document, asks a model for an ' +
          'implementation, and records the result. Nothing is written to the room: the answer is a ' +
          'proposal to be reviewed and applied. `create` and `modify` are decided here by comparing ' +
          'each path against the room\'s existing files, not taken from the model, so an answer ' +
          'cannot claim a path is free when it is not. Broadcast to the room as `ai:generation`.',
        parameters: [{ $ref: '#/components/parameters/roomId' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/GenerateInput' } } },
        },
        responses: {
          201: {
            description: 'A change set, proposed and unapplied',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { generation: { $ref: '#/components/schemas/Generation' } },
                },
              },
            },
          },
          ...validationError(),
          ...authRequired(),
          ...error(403, 'Not a member of a private room', 'room_forbidden', 'You do not have access to this room'),
          ...rateLimited('Too many generations from this address, try again later'),
          ...error(502, 'The model failed, timed out, or answered in the wrong shape', 'ai_failed', 'The model did not answer in the expected shape.'),
          ...error(503, 'No model is configured on this server', 'ai_disabled', 'No ANTHROPIC_API_KEY is configured, so this server cannot reach a model.'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/generations': {
      get: {
        tags: ['AI'],
        summary: "The room's AI history",
        description: 'Summaries, newest first. Failures are recorded too. `limit` caps at 50.',
        parameters: [{ $ref: '#/components/parameters/roomId' }],
        responses: {
          200: {
            description: 'Past generations',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    generations: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/GenerationSummary' },
                    },
                  },
                },
              },
            },
          },
          ...authRequired(),
          ...error(403, 'Not a member of a private room', 'room_forbidden', 'You do not have access to this room'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/generations/{generationId}': {
      get: {
        tags: ['AI'],
        summary: 'One change set in full',
        description: 'Includes every proposed file and its contents, for review.',
        parameters: [
          { $ref: '#/components/parameters/roomId' },
          { $ref: '#/components/parameters/generationId' },
        ],
        responses: {
          200: {
            description: 'The change set',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { generation: { $ref: '#/components/schemas/Generation' } },
                },
              },
            },
          },
          ...authRequired(),
          ...error(404, 'No such generation in this room', 'generation_not_found', 'No such generation in this room'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/generations/{generationId}/apply': {
      post: {
        tags: ['AI'],
        summary: 'Accept part of a change set',
        description:
          'Writes the accepted files into the room\'s files and records everything else as ' +
          'rejected, so the change set always says what was decided rather than leaving it open. ' +
          'Partial by construction — `accept` names what is wanted and an empty array means none ' +
          'of it. A file that cannot be applied stays proposed with an error against it rather ' +
          'than failing the rest. Broadcast as `ai:applied`.',
        parameters: [
          { $ref: '#/components/parameters/roomId' },
          { $ref: '#/components/parameters/generationId' },
        ],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ApplyInput' } } },
        },
        responses: {
          200: {
            description: 'What was applied, rejected and failed',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    generation: { $ref: '#/components/schemas/Generation' },
                    applied: { type: 'integer' },
                    rejected: { type: 'integer' },
                    failed: { type: 'integer' },
                  },
                },
              },
            },
          },
          ...validationError(),
          ...authRequired(),
          ...error(404, 'No such generation in this room', 'generation_not_found', 'No such generation in this room'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/run': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      post: {
        tags: ['Code execution'],
        summary: "Run the caller's copy of the buffer",
        description: [
          'Executes the posted code and returns what it printed; the result is also broadcast to everyone in the room over Socket.io as `code:run`.',
          '',
          'The code travels in the request because whoever pressed Run is looking at their local copy, which may be a keystroke ahead of the server\u2019s.',
          'Anonymous callers may pass `as` for attribution; signed-in callers are always attributed from their token.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RunRequest' } } },
        },
        responses: {
          200: {
            description: "What the program printed — even a crash is a 200",
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { run: { $ref: '#/components/schemas/RunOutput' } },
                },
              },
            },
          },
          ...validationError(),
          ...error(400, 'The language has no runner on this machine', 'language_not_runnable', 'cobol has no runner here — it can be edited and shared, but not run'),
          ...{
            403: {
              description:
                'Either the room is private and you cannot read it (`room_forbidden`), or this server has code execution switched off entirely (`execution_disabled`, ALLOW_CODE_EXECUTION=false).',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  examples: {
                    room_forbidden: {
                      summary: 'No access to the room',
                      value: { error: { code: 'room_forbidden', message: 'You do not have access to this room' } },
                    },
                    execution_disabled: {
                      summary: 'Running code is switched off server-wide',
                      value: { error: { code: 'execution_disabled', message: 'Running code is switched off on this server' } },
                    },
                  },
                },
              },
            },
            429: {
              description:
                'Two independent budgets: the per-IP run limiter (`rate_limited`, see RateLimit headers) or the server-wide concurrency cap on simultaneously running programs (`runner_busy`). The latter clears as other runs finish.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  examples: {
                    rate_limited: {
                      summary: 'Too many runs from this address',
                      value: { error: { code: 'rate_limited', message: 'Too many runs from this address, try again later' } },
                    },
                    runner_busy: {
                      summary: 'Server is at its concurrent-run limit',
                      value: { error: { code: 'runner_busy', message: 'Too many programs are running right now, try again in a moment' } },
                    },
                  },
                },
              },
            },
          },
          ...error(501, 'Toolchain not installed', 'toolchain_missing', 'g++ is not installed on the server, so cpp cannot run here'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/executions': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      get: {
        tags: ['Code execution'],
        summary: "A room's recent runs",
        description: [
          'The console is emptied by a page reload, and unlike the rest of the room it is not a Yjs document that can rebuild itself. This is where it reloads from.',
          '',
          'Rows expire on their own after SANDBOX_RETENTION_HOURS: program output is whatever somebody typed into a shared editor, and keeping it indefinitely is a liability rather than a feature.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'How many to return, newest first (1-100).',
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        ],
        responses: {
          200: {
            description: 'Newest first',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    executions: { type: 'array', items: { $ref: '#/components/schemas/Execution' } },
                  },
                },
              },
            },
          },
          ...error(403, 'No access to the room', 'room_forbidden', 'You do not have access to this room'),
        },
      },
    },

    '/api/v1/rooms/{roomId}/executions/{executionId}': {
      parameters: [
        { $ref: '#/components/parameters/roomId' },
        { $ref: '#/components/parameters/executionId' },
      ],
      get: {
        tags: ['Code execution'],
        summary: 'One run',
        description:
          'The id is the one carried by every `execution:state` broadcast about the run, and by the finished `code:run`.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'The run',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { execution: { $ref: '#/components/schemas/Execution' } },
                },
              },
            },
          },
          ...error(403, 'No access to the room', 'room_forbidden', 'You do not have access to this room'),
          ...error(404, 'No such run, or it belongs to another room', 'execution_not_found', 'No such execution'),
        },
      },
      delete: {
        tags: ['Code execution'],
        summary: 'Stop a running program',
        description: [
          'Whoever started a run can stop it, and so can the room owner — somebody has to be able to end a program in their own room without waiting out the timeout.',
          '',
          'A run that has already finished answers `{ cancelled: false }` with its final state rather than an error: pressing Cancel as a program exits is a race, not a mistake.',
          '',
          'Anonymous callers must pass `as` with the same name the run was started under — a guest has no account, so that name is the only thing that says the program is theirs. Signed-in callers are identified from their token and `as` is ignored.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            name: 'as',
            in: 'query',
            required: false,
            description: 'The guest name the run was started under. Ignored for signed-in callers.',
            schema: { type: 'string', maxLength: 32 },
          },
        ],
        responses: {
          200: {
            description: 'Whether anything was actually stopped',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    cancelled: { type: 'boolean' },
                    state: { $ref: '#/components/schemas/ExecutionState' },
                  },
                },
                examples: {
                  stopped: { summary: 'It was running', value: { cancelled: true, state: 'cancelled' } },
                  too_late: {
                    summary: 'It had already finished',
                    value: { cancelled: false, state: 'completed' },
                  },
                },
              },
            },
          },
          ...error(
            403,
            'Not yours to stop, or no access to the room',
            'execution_forbidden',
            'You can only stop a program you started'
          ),
          ...error(404, 'No such run, or it belongs to another room', 'execution_not_found', 'No such execution'),
        },
      },
    },

    '/api/v1/invitations/{token}': {
      parameters: [{ $ref: '#/components/parameters/invitationToken' }],
      get: {
        tags: ['Invitations'],
        summary: 'What an invitation is for',
        description: [
          'Read before accepting, usually by somebody who has just followed a link from their email and has not signed in yet — telling them which room they have been invited to is what makes finishing the sign-up worth doing.',
          '',
          'Unknown, expired and already-spent tokens all answer the same 404. There is no branch here that could tell somebody probing which of the three they hit.',
        ].join('\n'),
        security: [],
        responses: {
          200: {
            description: 'The invitation',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { invitation: { $ref: '#/components/schemas/Invitation' } },
                },
              },
            },
          },
          ...error(400, 'Not even the right shape', 'invitation_invalid', 'This invitation is invalid or has expired'),
          ...error(404, 'Unknown, expired or already used', 'invitation_invalid', 'This invitation is invalid or has expired'),
        },
      },
    },

    '/api/v1/invitations/{token}/accept': {
      parameters: [{ $ref: '#/components/parameters/invitationToken' }],
      post: {
        tags: ['Invitations'],
        summary: 'Spend an invitation',
        description: [
          'Turns the invitation into a membership. Four things must hold, and each closes something specific:',
          '',
          '- the token resolves — otherwise it is expired, spent or invented',
          '- the account’s address matches the one invited — otherwise forwarding the email is a way into somebody else’s room',
          '- that address has been verified — an invitation must not be a way around proving you can read the mailbox it was sent to',
          '- the person has not been removed from the room — a removal outranks an older invitation',
          '',
          'Accepting removes the invitation, so a second attempt finds nothing: single-use here is an absence, not a flag some later query could forget to filter on.',
          '',
          'A mismatched address answers the same 404 as an unknown token — saying which address it was meant for is exactly what the binding protects.',
        ].join('\n'),
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Joined',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    room: { $ref: '#/components/schemas/Room' },
                    role: { $ref: '#/components/schemas/AssignableRole' },
                  },
                },
              },
            },
          },
          ...authRequired(),
          ...{
            403: {
              description:
                'The account exists but may not accept: `email_not_verified` until the address is proven, `room_forbidden` for somebody the room removed.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' },
                  examples: {
                    email_not_verified: {
                      summary: 'Address not yet proven',
                      value: { error: { code: 'email_not_verified', message: 'Verify your email address before accepting this invitation' } },
                    },
                    room_forbidden: {
                      summary: 'Removed from the room',
                      value: { error: { code: 'room_forbidden', message: 'You do not have access to this room' } },
                    },
                  },
                },
              },
            },
          },
          ...error(404, 'Unknown, expired, spent, or sent to another address', 'invitation_invalid', 'This invitation is invalid or has expired'),
        },
      },
    },

    '/api/v1/runners': {
      get: {
        tags: ['Code execution'],
        summary: 'Which languages this machine can run, and how it contains them',
        description: 'A property of the machine, deliberately not per-room: clients consult it before offering the Run button.',
        security: [],
        responses: {
          200: {
            description: 'Availability report',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    enabled: { type: 'boolean', description: 'Whether running code is allowed at all' },
                    timeoutMs: { type: 'integer', description: 'Wall-clock limit per program' },
                    languages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/RunnerLanguage' },
                    },
                    isolation: {
                      allOf: [{ $ref: '#/components/schemas/Isolation' }],
                      nullable: true,
                      description: 'Null when execution is switched off entirely.',
                    },
                  },
                  example: {
                    enabled: true,
                    timeoutMs: 5000,
                    languages: [
                      { language: 'javascript', available: true, toolchain: 'Node.js', version: 'v22.9.0' },
                      { language: 'rust', available: false, toolchain: 'Rust', version: '' },
                    ],
                    isolation: {
                      backend: 'docker',
                      available: true,
                      weak: false,
                      unenforced: [],
                      limits: { timeoutMs: 5000, memoryMb: 256, cpus: 1, processes: 64, network: false },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },

  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Token issued by register or login; expires after JWT_EXPIRES_IN (default 7d).',
      },
    },

    parameters: {
      generationId: {
        name: 'generationId',
        in: 'path',
        required: true,
        description: 'Id of a generation from the room history.',
        schema: { type: 'string', pattern: '^[0-9a-f]{24}$' },
      },
      invitationToken: {
        name: 'token',
        in: 'path',
        required: true,
        description: 'The invitation token from the emailed link. Single-use and bound to one address.',
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' },
      },
      executionId: {
        name: 'executionId',
        in: 'path',
        required: true,
        description: 'Id of a run, as carried by every broadcast about it.',
        schema: { type: 'string', format: 'uuid' },
      },
      roomId: {
        name: 'roomId',
        in: 'path',
        required: true,
        description: 'Short id from the URL or the create call (8 characters).',
        schema: { type: 'string', minLength: 1, maxLength: 64 },
      },
      userId: {
        name: 'userId',
        in: 'path',
        required: true,
        description: 'Id of the account being acted on.',
        schema: { type: 'string', pattern: '^[a-f0-9]{24}$' },
      },
    },

    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', description: 'Stable machine-readable identifier' },
              message: { type: 'string', description: 'Human-readable explanation' },
            },
          },
        },
      },

      User: {
        type: 'object',
        required: ['id', 'email', 'name', 'emailVerified'],
        properties: {
          id: { type: 'string', description: '24-character hex id' },
          email: { type: 'string', format: 'email' },
          name: { type: 'string', maxLength: 32 },
          emailVerified: { type: 'boolean' },
        },
      },

      AuthSession: {
        type: 'object',
        required: ['user', 'token'],
        properties: {
          user: { $ref: '#/components/schemas/User' },
          token: { type: 'string', description: 'JWT; send as `Authorization: Bearer <token>`' },
        },
      },

      RegisterInput: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 160 },
          password: { type: 'string', minLength: 8, maxLength: 200 },
          name: { type: 'string', minLength: 1, maxLength: 32, description: 'Defaults to the part before @.' },
        },
      },

      LoginInput: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 160 },
          password: { type: 'string', minLength: 8, maxLength: 200 },
        },
      },

      ChangePasswordInput: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1 },
          newPassword: { type: 'string', minLength: 8, maxLength: 200 },
        },
      },

      VerifyEmailInput: {
        type: 'object',
        description:
          'Either proof will do, and exactly one is needed. One endpoint rather than two, because a client that has just been handed a code should not have to know it is now talking to a different route.',
        properties: {
          token: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Hex token from the emailed link.' },
          code: {
            type: 'string',
            pattern: '^[0-9]{6}$',
            description: 'The six digits from the same email.',
          },
          email: {
            type: 'string',
            format: 'email',
            description:
              'Which account the code belongs to, when there is no session. Ignored for a signed-in caller, whose account comes from the token — six digits are not unique across users, so a code is never matched by value alone.',
          },
        },
        anyOf: [{ required: ['token'] }, { required: ['code'] }],
      },

      Invitation: {
        type: 'object',
        description:
          'What an invitation is for, shown before anybody commits to anything. Deliberately thin: the room and who invited you, and nothing about who else is in it — an invitation is a key to one room, not a directory.',
        properties: {
          roomId: { type: 'string' },
          roomName: { type: 'string' },
          role: { $ref: '#/components/schemas/AssignableRole' },
          invitedBy: { type: ['string', 'null'], description: 'Display name of whoever sent it.' },
          expiresAt: { type: 'string', format: 'date-time' },
        },
      },

      ArchitectureNode: {
        type: 'object',
        required: ['id', 'key', 'type', 'label'],
        properties: {
          id: { type: 'string', description: 'The whiteboard shape this came from' },
          key: { type: 'string', description: 'Stable slug, unique within the graph; what edges refer to' },
          type: {
            type: 'string',
            description: 'Inferred from the label and the shape: datastore, cache, queue, gateway, api, auth, client, worker, external, service, decision, component',
          },
          label: { type: 'string', description: 'Text found inside the shape' },
          description: { type: ['string', 'null'], description: 'Further lines inside the same shape' },
          shape: { type: 'string', enum: ['rect', 'diamond', 'ellipse'] },
          author: { type: ['string', 'null'], description: 'Who drew it' },
          createdAt: { type: ['number', 'null'] },
        },
      },

      ArchitectureEdge: {
        type: 'object',
        required: ['id', 'source', 'target', 'directed'],
        properties: {
          id: { type: 'string' },
          source: { type: 'string', description: 'Node key the connector starts at' },
          target: { type: 'string', description: 'Node key it ends at' },
          sourceId: { type: 'string' },
          targetId: { type: 'string' },
          directed: {
            type: 'boolean',
            description: 'True for an arrow. A plain line relates two things without saying which way it flows.',
          },
          relationship: {
            type: ['string', 'null'],
            description: 'Text written on the connector, if any',
          },
          author: { type: ['string', 'null'] },
        },
      },

      Architecture: {
        type: 'object',
        required: ['nodes', 'edges', 'notes', 'warnings'],
        properties: {
          nodes: { type: 'array', items: { $ref: '#/components/schemas/ArchitectureNode' } },
          edges: { type: 'array', items: { $ref: '#/components/schemas/ArchitectureEdge' } },
          notes: {
            type: 'array',
            description: 'Text on the board that belongs to no shape and no connector',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                text: { type: 'string' },
                author: { type: ['string', 'null'] },
              },
            },
          },
          warnings: {
            type: 'array',
            description:
              'What the diagram could not express: an arrow reaching nothing, a box nobody labelled, two boxes with one name. Shown to the user and repeated to the model, so a gap is reported rather than invented.',
            items: {
              type: 'object',
              properties: {
                code: {
                  type: 'string',
                  enum: [
                    'dangling_connector',
                    'self_connector',
                    'unlabelled_node',
                    'isolated_node',
                    'duplicate_label',
                    'no_components',
                  ],
                },
                message: { type: 'string' },
                shapeId: { type: ['string', 'null'] },
              },
            },
          },
          source: {
            type: 'string',
            enum: ['live', 'snapshot', 'log'],
            description: 'Where the shapes were read from. `live` is the in-memory document.',
          },
          stats: { type: 'object' },
        },
      },

      GenerateInput: {
        type: 'object',
        required: ['targets'],
        properties: {
          targets: {
            type: 'array',
            minItems: 1,
            items: { type: 'string', enum: ['backend', 'api', 'database', 'frontend'] },
          },
          intent: {
            type: 'string',
            maxLength: 2000,
            description: 'Anything the diagram cannot say — stack, conventions, constraints.',
          },
        },
      },

      ApplyInput: {
        type: 'object',
        required: ['accept'],
        properties: {
          accept: {
            type: 'array',
            description: 'Ids of the files being accepted. Everything else is recorded as rejected.',
            items: { type: 'string', pattern: '^[0-9a-f]{24}$' },
          },
        },
      },

      ProposedFile: {
        type: 'object',
        required: ['id', 'path', 'action', 'status'],
        properties: {
          id: { type: 'string' },
          path: { type: 'string', description: 'Relative path. Never absolute, never with `..`.' },
          action: {
            type: 'string',
            enum: ['create', 'modify', 'delete'],
            description: 'Decided by the server against the room\'s existing files, not by the model.',
          },
          language: { type: ['string', 'null'] },
          contents: { type: 'string', description: 'The whole file. Empty for a delete.' },
          rationale: { type: ['string', 'null'] },
          size: { type: 'integer' },
          status: { type: 'string', enum: ['proposed', 'applied', 'rejected'] },
          appliedFileId: { type: ['string', 'null'], description: 'The room file this became' },
          appliedAt: { type: ['string', 'null'], format: 'date-time' },
          error: { type: ['string', 'null'], description: 'Why applying this one failed' },
          previous: {
            type: ['string', 'null'],
            description: 'Current contents of the file being modified, so the change can be read. Only on the generate response.',
          },
        },
      },

      GenerationSummary: {
        type: 'object',
        required: ['id', 'status', 'createdAt'],
        properties: {
          id: { type: 'string' },
          roomId: { type: 'string' },
          status: { type: 'string', enum: ['succeeded', 'failed'] },
          requestedBy: { type: ['string', 'null'] },
          requestedByName: { type: ['string', 'null'] },
          targets: { type: 'array', items: { type: 'string' } },
          summary: { type: ['string', 'null'] },
          counts: { type: 'object' },
          nodes: { type: 'integer' },
          edges: { type: 'integer' },
          questions: { type: 'integer' },
          model: { type: ['string', 'null'] },
          durationMs: { type: ['integer', 'null'] },
          error: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },

      Generation: {
        allOf: [
          { $ref: '#/components/schemas/GenerationSummary' },
          {
            type: 'object',
            properties: {
              intent: { type: ['string', 'null'] },
              architecture: { $ref: '#/components/schemas/Architecture' },
              plan: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { step: { type: 'string' }, detail: { type: ['string', 'null'] } },
                },
              },
              assumptions: {
                type: 'array',
                description: 'Decisions the model made that the diagram did not specify.',
                items: { type: 'string' },
              },
              questions: {
                type: 'array',
                description: 'What the diagram is missing that a person needs to answer.',
                items: { type: 'string' },
              },
              rejected: {
                type: 'array',
                description: 'What the server refused or corrected in the answer, and why.',
                items: { type: 'string' },
              },
              usage: { type: 'object' },
              files: { type: 'array', items: { $ref: '#/components/schemas/ProposedFile' } },
            },
          },
        ],
      },

      Session: {
        type: 'object',
        required: ['id', 'lastSeenAt', 'createdAt', 'expiresAt'],
        properties: {
          id: { type: 'string', description: 'Pass to DELETE /auth/sessions/{sessionId}' },
          userAgent: { type: ['string', 'null'], description: 'Raw User-Agent header, as sent' },
          ip: { type: ['string', 'null'], description: 'Address the session was opened from' },
          lastSeenAt: { type: 'string', format: 'date-time', description: 'Refreshed at most once a minute' },
          createdAt: { type: 'string', format: 'date-time' },
          expiresAt: { type: 'string', format: 'date-time' },
          current: { type: 'boolean', description: 'The session making this request' },
        },
      },

      ForgotPasswordInput: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email', maxLength: 160 },
        },
      },

      ResetPasswordInput: {
        type: 'object',
        required: ['token', 'password'],
        properties: {
          token: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Hex token from the emailed link.' },
          password: { type: 'string', minLength: 8, maxLength: 200, description: 'The new password.' },
        },
      },

      Room: {
        type: 'object',
        required: ['roomId', 'name', 'isPublic', 'owner', 'memberCount', 'lastActivityAt'],
        properties: {
          roomId: { type: 'string', description: '8-character id, usable directly in a room URL' },
          name: { type: 'string', maxLength: 80 },
          isPublic: { type: 'boolean', description: 'Public rooms admit any signed-in visitor' },
          owner: { type: ['string', 'null'], description: 'Owner id, or null for ad-hoc rooms' },
          description: { type: 'string', maxLength: 280, description: 'A line about what the room is for; empty when nobody has set one' },
          kind: {
            type: 'string',
            enum: ['general', 'coding', 'interview', 'system-design'],
            description: 'What the room is for. "general" is the default and means unclassified, not miscellaneous.',
          },
          memberCount: { type: 'integer' },
          lastActivityAt: { type: 'string', format: 'date-time', description: 'Somebody was in the room' },
          updatedAt: { type: 'string', format: 'date-time', description: 'The room itself was changed' },
        },
      },

      RoomPreferenceInput: {
        type: 'object',
        minProperties: 1,
        description: 'At least one of `pinned` or `archived`. Omitting one leaves it as it was, so two controls on a card can write independently.',
        properties: {
          pinned: { type: 'boolean' },
          archived: { type: 'boolean' },
        },
      },

      Activity: {
        type: 'object',
        required: ['id', 'roomId', 'kind', 'at'],
        properties: {
          id: { type: 'string' },
          roomId: { type: 'string' },
          kind: {
            type: 'string',
            enum: [
              'code.edited',
              'whiteboard.updated',
              'execution.completed',
              'comment.added',
              'collaborator.joined',
            ],
          },
          actorId: { type: ['string', 'null'], description: 'Null for a guest, who has no account' },
          actorName: { type: ['string', 'null'] },
          detail: { type: ['string', 'null'], description: 'A few words specific to the kind, such as the language a run used' },
          at: { type: 'string', format: 'date-time' },
        },
      },

      RoomEnvelope: {
        type: 'object',
        required: ['room'],
        properties: { room: { $ref: '#/components/schemas/Room' } },
      },

      RoomCreateInput: {
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 80, description: 'Defaults to "Untitled room".' },
          isPublic: { type: 'boolean', default: false },
          description: { type: 'string', maxLength: 280 },
          kind: {
            type: 'string',
            enum: ['general', 'coding', 'interview', 'system-design'],
            default: 'general',
          },
        },
      },

      RoomUpdateInput: {
        type: 'object',
        minProperties: 1,
        description: 'At least one of `name`, `description`, `kind` or `isPublic` must be present.',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          isPublic: { type: 'boolean' },
          description: {
            type: 'string',
            maxLength: 280,
            description: 'Empty string clears it, which is why this one allows an empty value where `name` does not.',
          },
          kind: { type: 'string', enum: ['general', 'coding', 'interview', 'system-design'] },
        },
      },

      InviteInput: {
        type: 'object',
        description: 'Exactly one of userId or email.',
        properties: {
          userId: { type: 'string', pattern: '^[a-f\\d]{24}$', description: 'Id of an existing user.' },
          email: {
            type: 'string',
            format: 'email',
            maxLength: 254,
            description: 'Email address of an existing account.',
          },
          role: { type: 'string', enum: ['editor', 'viewer'], default: 'editor' },
        },
      },

      BlockedPerson: {
        type: 'object',
        description: 'Someone the owner removed. Refused whether the room is public or private.',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          at: { type: 'string', format: 'date-time' },
        },
      },

      Member: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['owner', 'editor', 'viewer'] },
        },
      },

      Invited: {
        type: 'object',
        description: 'Who was let into the room, and whether they were told.',
        properties: {
          id: { type: 'string', nullable: true, description: 'Null while the invitation is pending.' },
          name: { type: 'string', nullable: true, description: 'Null while the invitation is pending.' },
          email: { type: 'string', format: 'email' },
          pending: {
            type: 'boolean',
            description:
              'Nobody has signed up under this address yet, so the invitation is held on the room rather than granting membership now. It is claimed when an account is created with the address.',
          },
          notified: {
            type: 'boolean',
            nullable: true,
            description:
              'True when the mail relay accepted the invitation, false when no relay is configured or it refused, and null when the send outlasted the invite deadline and is still running. Only false makes passing the room code on the owner’s job.',
          },
        },
      },

      Participant: {
        type: 'object',
        description: 'Someone who has actually opened the room.',
        properties: {
          id: { type: 'string' },
          userId: { type: ['string', 'null'] },
          name: { type: 'string' },
          guest: { type: 'boolean' },
          visits: { type: 'integer' },
          firstSeenAt: { type: 'string', format: 'date-time' },
          lastSeenAt: { type: 'string', format: 'date-time' },
        },
      },

      PeopleRoster: {
        type: 'object',
        properties: {
          owner: {
            allOf: [{ $ref: '#/components/schemas/Member' }],
            nullable: true,
            description: 'Null for ad-hoc rooms nobody claimed.',
          },
          members: { type: 'array', items: { $ref: '#/components/schemas/Member' } },
          blocked: { type: 'array', items: { $ref: '#/components/schemas/BlockedPerson' } },
          pending: {
            type: 'array',
            description:
              'Addresses invited that nobody has signed up with yet. Each becomes a member when an account is created with it.',
            items: { $ref: '#/components/schemas/PendingInvite' },
          },
          participants: { type: 'array', items: { $ref: '#/components/schemas/Participant' } },
        },
      },

      PendingInvite: {
        type: 'object',
        description: 'An invitation waiting on an account that does not exist yet.',
        properties: {
          email: { type: 'string', format: 'email' },
          role: { type: 'string', enum: ['editor', 'viewer'] },
          at: { type: 'string', format: 'date-time' },
        },
      },

      TimelineEntry: {
        type: 'object',
        properties: {
          seq: { type: 'integer', minimum: 0, description: 'Position in the append-only update log' },
          actor: { type: ['string', 'null'], description: 'Client id that produced the update' },
          size: { type: 'integer', description: 'Encoded size in bytes' },
          at: { type: 'string', format: 'date-time' },
        },
      },

      RunRequest: {
        type: 'object',
        required: ['language', 'code'],
        properties: {
          language: {
            type: 'string',
            maxLength: 32,
            description: 'One of the runnable keys reported by /runners.',
          },
          code: { type: 'string', maxLength: 100000 },
          stdin: { type: 'string', maxLength: 10000 },
          runId: {
            type: 'string',
            maxLength: 64,
            description: 'Echoed back in the broadcast so clients recognise their own run.',
          },
          as: {
            type: 'string',
            maxLength: 32,
            description: 'Guest display name for attribution; ignored for signed-in callers.',
          },
        },
      },

      Role: {
        type: 'string',
        enum: ['owner', 'admin', 'editor', 'runner', 'commenter', 'viewer'],
        description: [
          'What somebody may do in a room. Each role grants everything the one below it does, plus more:',
          '',
          '- `viewer` — read the room and its history, nothing else',
          '- `commenter` — a viewer who may also send chat messages',
          '- `runner` — a commenter who may also run code, without being able to change it',
          '- `editor` — draw, edit code, upload and delete files, run code, generate from the whiteboard',
          '- `admin` — an editor who may also change room settings, invite and remove people, and assign roles below their own',
          '- `owner` — everything, including deleting the room, transferring it, and appointing admins',
        ].join('\n'),
      },

      AssignableRole: {
        type: 'string',
        enum: ['admin', 'editor', 'runner', 'commenter', 'viewer'],
        description: 'Ownership is absent deliberately: it moves by transfer, never by editing a membership.',
      },

      RoomAccess: {
        type: 'object',
        description:
          'What the caller may do in this room, sent with the room so a client can hide what it cannot do rather than offering buttons that fail. The capability list is sent rather than the role alone, so the mapping lives in one place.',
        properties: {
          role: { allOf: [{ $ref: '#/components/schemas/Role' }], nullable: true },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'e.g. `code:edit`, `code:execute`, `files:upload`, `chat:send`, `roles:manage`.',
          },
          assignable: {
            type: 'array',
            items: { $ref: '#/components/schemas/AssignableRole' },
            description: 'Roles this caller may hand out. Empty for anybody who cannot manage roles.',
          },
          isGuest: { type: 'boolean', description: 'True when there is no account behind the request.' },
        },
      },

      RunOutput: {
        type: 'object',
        required: ['language', 'stage', 'ok'],
        properties: {
          language: { type: 'string' },
          stage: { type: 'string', enum: ['compile', 'run'], description: '"compile" when compilation already failed' },
          ok: { type: 'boolean', description: 'Exit code zero within the time limit' },
          stdout: { type: 'string', description: 'Host paths are redacted out of both streams before anyone sees them' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'integer' },
          exitCode: { type: ['integer', 'null'] },
          signal: { type: ['string', 'null'] },
          executionId: { type: 'string', format: 'uuid', description: 'Names this run for cancellation and history' },
          state: { $ref: '#/components/schemas/ExecutionState' },
          termination: { $ref: '#/components/schemas/Termination' },
          backend: { type: ['string', 'null'], enum: ['docker', 'process', null], description: 'Which isolation actually ran it' },
          sourceHash: { type: 'string', description: 'SHA-256 of the code that ran' },
        },
      },

      ExecutionState: {
        type: 'string',
        enum: ['queued', 'running', 'completed', 'failed', 'timed_out', 'resource_limit', 'cancelled'],
        description:
          '`resource_limit` is a memory, output or process ceiling; `failed` is the program exiting non-zero.',
      },

      Termination: {
        type: ['string', 'null'],
        enum: [
          'exited',
          'timeout',
          'memory_limit',
          'output_limit',
          'process_limit',
          'cancelled',
          'failed_to_start',
          'internal_error',
          null,
        ],
        description: 'Why it ended. Finer than the state: `resource_limit` covers three of these.',
      },

      Execution: {
        type: 'object',
        description: 'One run, as recorded. Output is stored already capped and already redacted.',
        properties: {
          executionId: { type: 'string', format: 'uuid' },
          roomId: { type: 'string' },
          by: {
            type: ['object', 'null'],
            properties: { id: { type: ['string', 'null'] }, name: { type: ['string', 'null'] } },
            description: 'Null id for a guest, who has no account to point at',
          },
          language: { type: 'string' },
          sourceHash: { type: 'string', description: 'Answers "was this the same code?" without storing it' },
          state: { $ref: '#/components/schemas/ExecutionState' },
          termination: { $ref: '#/components/schemas/Termination' },
          stage: { type: ['string', 'null'], enum: ['compile', 'run', null] },
          queuedAt: { type: 'string', format: 'date-time' },
          startedAt: { type: ['string', 'null'], format: 'date-time' },
          finishedAt: { type: ['string', 'null'], format: 'date-time' },
          durationMs: { type: 'integer', description: 'Time inside the sandbox, not since the button was pressed' },
          exitCode: { type: ['integer', 'null'] },
          signal: { type: ['string', 'null'] },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },

      Isolation: {
        type: 'object',
        description: [
          'What this deployment does and does not stop a program from doing.',
          '',
          'Reported rather than assumed, because it depends on how the server was deployed: with a container runtime a program cannot open a socket or read the filesystem, and without one it certainly can. A client should treat `weak: true` as a reason to warn.',
        ].join('\n'),
        properties: {
          backend: { type: 'string', enum: ['docker', 'process'], description: 'What actually ran it' },
          available: { type: 'boolean', description: 'False when SANDBOX_BACKEND=docker and no runtime answered' },
          weak: { type: 'boolean', description: 'True when any control is unenforced' },
          unenforced: {
            type: 'array',
            items: { type: 'string' },
            description: 'The controls this backend cannot impose. Empty under Docker.',
          },
          enforcement: {
            type: 'object',
            additionalProperties: { type: 'string', enum: ['enforced', 'none'] },
            description: 'One answer per control: timeout, output, memory, cpu, processes, filesystem, network, environment, cleanup.',
          },
          limits: {
            type: 'object',
            properties: {
              timeoutMs: { type: 'integer' },
              outputBytes: { type: 'integer' },
              memoryMb: { type: 'integer' },
              cpus: { type: 'number' },
              processes: { type: 'integer' },
              fileSizeMb: { type: 'integer' },
              network: { type: 'boolean' },
            },
          },
        },
      },

      RunnerLanguage: {
        type: 'object',
        properties: {
          language: { type: 'string' },
          available: { type: 'boolean', description: 'Probed once at first request' },
          toolchain: { type: 'string' },
          version: { type: 'string' },
        },
      },
    },
  },
}

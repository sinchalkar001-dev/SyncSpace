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
const authRequired = () => error(401, 'Missing, malformed or expired bearer token', 'unauthorized', 'A valid bearer token is required')
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
    { name: 'Invitations', description: 'Granting users access to a room' },
    { name: 'Replay', description: 'Timeline metadata and historical document state' },
    { name: 'Code execution', description: 'Running a room buffer and discovering runnable toolchains' },
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
        description: 'Existing tokens stay valid until they expire; there is no global revocation.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ChangePasswordInput' } } },
        },
        responses: {
          200: {
            description: 'Password changed',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' } } },
              },
            },
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
        description: 'Public: the token itself proves control of the address. Consumed on first use.',
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
          ...error(400, 'Token unknown, expired or already used', 'invalid_token', 'This verification link is invalid or has expired'),
          ...rateLimited('Too many verification attempts, try again later'),
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

    '/api/v1/rooms/{roomId}/people': {
      parameters: [{ $ref: '#/components/parameters/roomId' }],
      get: {
        tags: ['Users', 'Rooms'],
        summary: 'Roster of a room',
        description: 'Owner, invited members, and everyone who actually opened the room. Owned rooms show this only to owner and members.',
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
        description: 'Owner only. Inviting someone already in the room succeeds without changing their role.',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/InviteInput' } } },
        },
        responses: {
          200: {
            description: 'Membership recorded (idempotent)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/RoomEnvelope' } } },
          },
          ...validationError(),
          ...authRequired(),
          ...error(403, 'Only the owner can invite people', 'not_owner', 'Only the room owner can invite people'),
          ...error(404, 'No room under that id', 'room_not_found', 'Room not found'),
          ...rateLimited('Too many invites sent, try again later'),
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
      ],
      get: {
        tags: ['Replay'],
        summary: 'Document update timeline',
        description: 'Metadata for a replay scrubber — never payloads. Requires PERSIST_UPDATE_LOG=true, otherwise refused.',
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
        description: 'A Yjs update stream ready for `Y.applyUpdate`. The `X-Updates-Applied` header counts the folded entries.',
        security: [{ bearerAuth: [] }],
        responses: {
          200: {
            description: 'Raw Yjs state',
            headers: {
              'X-Updates-Applied': {
                description: 'Number of log entries folded into the response',
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
          ...error(403, 'Private room you cannot read, or execution switched off', 'room_forbidden', 'You do not have access to this room'),
          ...rateLimited('Too many runs from this address, try again later'),
          ...error(501, 'Toolchain not installed', 'toolchain_missing', 'g++ is not installed on the server, so cpp cannot run here'),
        },
      },
    },

    '/api/v1/runners': {
      get: {
        tags: ['Code execution'],
        summary: 'Which languages this machine can run',
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
                  },
                  example: {
                    enabled: true,
                    timeoutMs: 5000,
                    languages: [
                      { language: 'javascript', available: true, toolchain: 'Node.js', version: 'v22.9.0' },
                      { language: 'rust', available: false, toolchain: 'Rust', version: '' },
                    ],
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
      roomId: {
        name: 'roomId',
        in: 'path',
        required: true,
        description: 'Short id from the URL or the create call (8 characters).',
        schema: { type: 'string', minLength: 1, maxLength: 64 },
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
        required: ['token'],
        properties: {
          token: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Hex token from the emailed link.' },
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
          memberCount: { type: 'integer' },
          lastActivityAt: { type: 'string', format: 'date-time' },
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
        },
      },

      RoomUpdateInput: {
        type: 'object',
        minProperties: 1,
        description: 'At least one of `name` or `isPublic` must be present.',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 80 },
          isPublic: { type: 'boolean' },
        },
      },

      InviteInput: {
        type: 'object',
        required: ['userId'],
        properties: {
          userId: { type: 'string', pattern: '^[a-f\\d]{24}$', description: 'Id of an existing user.' },
          role: { type: 'string', enum: ['editor', 'viewer'], default: 'editor' },
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
          participants: { type: 'array', items: { $ref: '#/components/schemas/Participant' } },
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

      RunOutput: {
        type: 'object',
        required: ['language', 'stage', 'ok'],
        properties: {
          language: { type: 'string' },
          stage: { type: 'string', enum: ['compile', 'run'], description: '"compile" when compilation already failed' },
          ok: { type: 'boolean', description: 'Exit code zero within the time limit' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
          timedOut: { type: 'boolean' },
          durationMs: { type: 'integer' },
          exitCode: { type: ['integer', 'null'] },
          signal: { type: ['string', 'null'] },
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

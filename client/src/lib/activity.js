/**
 * Turning an activity row into a line somebody can read.
 *
 * The server records what happened; this decides how it is said. Keeping the
 * two apart is what lets the wording change without a migration, and what
 * stops the API from having to guess how a sentence should read in a list it
 * cannot see.
 *
 * Every line is written to sit under a room name, so it starts with the person
 * and never repeats the room: "Jishu edited the code", not "Jishu edited the
 * code in Interview".
 */

const KINDS = {
  'code.edited': { icon: 'code', verb: 'edited the code' },
  'whiteboard.updated': { icon: 'pen', verb: 'updated the whiteboard' },
  'execution.completed': { icon: 'play', verb: 'ran the code' },
  'comment.added': { icon: 'inbox', verb: 'said something in chat' },
  'comment.posted': { icon: 'comment', verb: 'commented' },
  'collaborator.joined': { icon: 'users', verb: 'joined the room' },
}

/** An unknown kind is rendered plainly rather than dropped or crashed on. */
const UNKNOWN = { icon: 'activity', verb: 'did something' }

export const activityIcon = (event) => (KINDS[event?.kind] ?? UNKNOWN).icon

/**
 * "Jishu ran the code" — or "Somebody ran the code" for a guest who never gave
 * a name. Never "null ran the code", which is what an unguarded template does
 * the first time an anonymous visitor touches anything.
 */
export function describeActivity(event) {
  const shape = KINDS[event?.kind] ?? UNKNOWN
  const who = event?.actorName?.trim() || 'Somebody'
  return who + ' ' + shape.verb
}

/**
 * The extra clause, when there is one worth showing.
 *
 * Kept separate from the sentence so the list can style it quietly: "ran the
 * code" is the event, "python ran cleanly" is the detail, and only one of them
 * needs to carry weight in a feed being skimmed.
 */
export const activityDetail = (event) => event?.detail?.trim() || null

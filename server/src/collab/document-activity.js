import { ACTIVITY, recordActivity } from '../services/activity.service.js'

/**
 * Turning Yjs transactions into "somebody edited the code".
 *
 * The room's whiteboard and code buffer are two shared types on one document —
 * `shapes` and `code` — so an update alone does not say which was touched. The
 * transaction does: it carries the set of types that changed, and every one of
 * them is either a root or nested inside one, so walking up to the root names
 * the half of the room that moved.
 *
 * Attribution needs no guesswork either. Hocuspocus applies a client's update
 * with the connection as the Yjs origin, and a connection carries the context
 * `onAuthenticate` returned — so `transaction.origin.context.user` is the
 * person who typed, straight from the layer that authenticated them.
 *
 * That origin is also the filter that keeps this honest. The server applies
 * updates too, replaying a snapshot and its log every time a document loads,
 * and those arrive with no origin at all. Without the check, opening a room
 * would announce that everybody in it had just edited everything.
 */

/** What the two halves of a room are called on the document. */
const CODE = 'code'
const SHAPES = 'shapes'

const KIND_OF = {
  [CODE]: ACTIVITY.CODE_EDITED,
  [SHAPES]: ACTIVITY.WHITEBOARD_UPDATED,
}

/**
 * The name of the root type this one lives under, or null.
 *
 * A changed type is often not a root: editing one shape changes the Y.Map for
 * that shape, which sits inside the `shapes` array. Roots are the types with
 * no item embedding them, so walking `parent` until `_item` is null lands on
 * one, and `doc.share` is what turns it back into a name.
 */
function rootNameOf(doc, type) {
  let current = type
  // Bounded rather than `while (true)`: a malformed parent chain must not
  // become an infinite loop inside somebody's keystroke.
  for (let depth = 0; current && current._item && depth < 32; depth += 1) {
    current = current.parent
  }
  if (!current || current._item) return null

  for (const [name, root] of doc.share) {
    if (root === current) return name
  }
  return null
}

/** Which halves of the room a transaction touched, as activity kinds. */
export function kindsChangedBy(doc, transaction) {
  const kinds = new Set()

  for (const type of transaction.changed.keys()) {
    const kind = KIND_OF[rootNameOf(doc, type)]
    if (kind) kinds.add(kind)
  }

  return [...kinds]
}

/**
 * Starts recording edits made to this document.
 *
 * Called from `afterLoadDocument`, which Hocuspocus runs once the snapshot and
 * update log have already been applied — so nothing the load itself did is
 * ever mistaken for somebody's work.
 */
export function watchDocument(documentName, document) {
  document.on('afterTransaction', (transaction) => {
    const user = transaction.origin?.context?.user
    if (!user) return

    for (const kind of kindsChangedBy(document, transaction)) {
      recordActivity({
        roomId: documentName,
        kind,
        actor: user.id ?? null,
        actorName: user.name ?? null,
        // Typing is continuous and means one thing; one row a minute is the
        // whole story without being every keystroke of it.
        collapse: true,
      })
    }
  })
}

import { Icon } from '../ui/Icon.jsx'
import { Skeleton } from '../ui/Skeleton.jsx'
import { Button } from '../ui/Button.jsx'

/**
 * What the server read on the whiteboard, shown before anything is generated.
 *
 * This is the part that makes the feature honest. The graph is recovered from
 * geometry — an arrow is four numbers, a label is a text shape that happens to
 * sit on a box — so it is sometimes wrong, and the right answer to a misread
 * diagram is the person fixing the diagram, not a model guessing around it.
 * Showing the reading first is what makes that possible; it also means nobody
 * pays for a generation against a picture the server did not understand.
 */

/** A word for each inferred component type, so the reading is checkable. */
const TYPE_LABELS = {
  datastore: 'Data store',
  cache: 'Cache',
  queue: 'Queue',
  gateway: 'Gateway',
  api: 'API',
  auth: 'Auth',
  client: 'Client',
  worker: 'Worker',
  external: 'External',
  service: 'Service',
  decision: 'Decision',
  component: 'Component',
}

/** Warnings the user can act on, versus ones that are merely informational. */
const SEVERITY = {
  no_components: 'error',
  dangling_connector: 'warn',
  unlabelled_node: 'warn',
  self_connector: 'warn',
  duplicate_label: 'info',
  isolated_node: 'info',
}

export function ArchitecturePreview({ state, graph, error, onRetry }) {
  if (state === 'loading') {
    return (
      <div className="arch" aria-busy="true">
        <Skeleton variant="title" width="40%" />
        <Skeleton width="70%" />
        <Skeleton width="55%" />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="arch">
        <div className="banner banner--error" role="alert">
          <Icon name="alert" size={15} className="banner__icon" />
          <span>{error}</span>
        </div>
        <Button icon="redo" onClick={onRetry}>
          Read the board again
        </Button>
      </div>
    )
  }

  if (!graph) return null

  const { nodes, edges, notes, warnings } = graph
  const blocking = warnings.filter((warning) => SEVERITY[warning.code] === 'error')

  if (nodes.length === 0) {
    return (
      <div className="arch">
        <div className="empty">
          <span className="empty__icon">
            <Icon name="layers" size={22} />
          </span>
          <h4>Nothing to read yet</h4>
          <p className="muted">
            Draw a box for each part of the system and put a text label inside it, then join them
            with arrows. Rectangles, diamonds and ellipses all count as components.
          </p>
          <Button icon="redo" onClick={onRetry}>
            Read the board again
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="arch">
      <div className="arch__head">
        <h4 className="arch__title">What the board says</h4>
        <span className="arch__count">
          {nodes.length} {nodes.length === 1 ? 'component' : 'components'} ·{' '}
          {edges.length} {edges.length === 1 ? 'connection' : 'connections'}
        </span>
        <Button size="sm" icon="redo" onClick={onRetry} title="Read the board again">
          Refresh
        </Button>
      </div>

      <ul className="arch__nodes">
        {nodes.map((node) => (
          <li key={node.id} className="arch__node">
            <span className={'arch__type arch__type--' + node.type}>
              {TYPE_LABELS[node.type] ?? node.type}
            </span>
            <span className="arch__label">{node.label}</span>
            {node.description && <span className="arch__desc muted">{node.description}</span>}
          </li>
        ))}
      </ul>

      {edges.length > 0 && (
        <ul className="arch__edges">
          {edges.map((edge) => (
            <li key={edge.id} className="arch__edge">
              <code>{edge.source}</code>
              {/* An arrow was drawn with a direction; a plain line was not, and
                  saying which way it flows would be inventing information. */}
              <span className="arch__arrow" aria-label={edge.directed ? 'to' : 'and'}>
                {edge.directed ? '→' : '—'}
              </span>
              <code>{edge.target}</code>
              {edge.relationship && <em className="arch__rel">{edge.relationship}</em>}
            </li>
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <div className="arch__notes">
          <h5>Notes on the board</h5>
          <ul>
            {notes.map((note) => (
              <li key={note.id}>{note.text}</li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="arch__warnings">
          <h5>
            <Icon name="alert" size={13} /> What could not be read
          </h5>
          <ul>
            {warnings.map((warning, index) => (
              <li key={warning.code + index} className={'arch__warning is-' + (SEVERITY[warning.code] ?? 'info')}>
                {warning.message}
              </li>
            ))}
          </ul>
          <p className="muted">
            {blocking.length > 0
              ? 'Fix this on the board and read it again.'
              : 'These are passed to the model as gaps rather than guessed at.'}
          </p>
        </div>
      )}
    </div>
  )
}

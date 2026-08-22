import { Modal } from './ui/Modal.jsx'

/**
 * The shortcuts that already exist, written down.
 *
 * Kept as data next to the handlers it documents: when a binding changes in
 * Whiteboard or CodeEditor, this list is the one other place to update.
 */
const GROUPS = [
  {
    title: 'Workspace',
    items: [
      ['Ctrl K', 'Command palette'],
      ['?', 'This panel'],
      ['Ctrl F', 'Find in code'],
      ['Ctrl S', 'Nothing — every edit is already saved'],
    ],
  },
  {
    title: 'Board tools',
    items: [
      ['V', 'Select'],
      ['H', 'Hand (pan)'],
      ['P', 'Pen'],
      ['L', 'Line'],
      ['A', 'Arrow'],
      ['R', 'Rectangle'],
      ['D', 'Diamond'],
      ['O', 'Ellipse'],
      ['T', 'Text'],
      ['E', 'Eraser'],
    ],
  },
  {
    title: 'Board editing',
    items: [
      ['Ctrl Z', 'Undo'],
      ['Ctrl Shift Z', 'Redo'],
      ['Ctrl A', 'Select everything'],
      ['Ctrl C / Ctrl V', 'Copy and paste'],
      ['Ctrl D', 'Duplicate selection'],
      ['Delete', 'Delete selection'],
      ['Shift click', 'Add to the selection'],
      ['Esc', 'Clear the selection'],
    ],
  },
]

export function ShortcutsPanel({ open, onClose }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="Board shortcuts apply while the canvas has focus."
      wide
    >
      <div className="shortcuts">
        {GROUPS.map((group) => (
          <section className="shortcuts__group" key={group.title}>
            <h3 className="shortcuts__title">{group.title}</h3>
            <dl className="shortcuts__list">
              {group.items.map(([keys, description]) => (
                <div className="shortcuts__row" key={group.title + keys}>
                  <dt>
                    {keys.split(' ').map((key, index) =>
                      key === '/' ? (
                        <span className="shortcuts__sep" key={index}>
                          /
                        </span>
                      ) : (
                        <kbd key={index}>{key}</kbd>
                      )
                    )}
                  </dt>
                  <dd>{description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  )
}

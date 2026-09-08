import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PersonRow, RoleSelect } from './PeopleList.jsx'

/**
 * The shape of a roster row.
 *
 * These are structure tests, not appearance tests, and they exist because the
 * appearance was wrong in a way jsdom cannot see: in a 21rem popover the name
 * is the only flex item that may shrink, so an avatar, a role select and a
 * Remove button between them squeezed it down to an initial and a full stop.
 * Nobody can decide whether to promote "J." — the roster stopped answering the
 * one question it exists to answer.
 *
 * The CSS that fixes it leans on two things being true of the markup, and both
 * are easy to undo by accident:
 *
 *   - the controls are one element, so they wrap as a unit rather than the
 *     select going to a second line and the button to a third;
 *   - a select is not put inside the `.people__tag` pill, which would give it
 *     the pill's padding and its `text-transform: lowercase`.
 *
 * Widths are asserted in the CSS by measurement, not here — jsdom has no
 * layout, and a test that pretended otherwise would pass on a broken panel.
 */

const LABELS = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }

describe('PersonRow', () => {
  it('keeps the tag and the action together so they wrap as one', () => {
    const { container } = render(
      <ul>
        <PersonRow
          name="Jishu Manideep"
          detail="manideep@syncspace.test"
          tag="editor"
          action={{ label: 'Remove', icon: 'close', onClick: () => {} }}
        />
      </ul>
    )

    const controls = container.querySelector('.people__controls')
    expect(controls).toBeInTheDocument()
    expect(controls.querySelector('.people__tag')).toHaveTextContent('editor')
    expect(controls.querySelector('button')).toHaveTextContent('Remove')

    // The name is not in there with them: it is the part that must get the
    // width back when the controls drop to their own line.
    expect(controls.querySelector('.people__who')).toBeNull()
  })

  it('does not put a control inside the tag pill', () => {
    const { container } = render(
      <ul>
        <PersonRow
          name="Jishu Manideep"
          detail="manideep@syncspace.test"
          tag={<RoleSelect value="admin" options={['admin', 'editor']} onChange={() => {}} labels={LABELS} />}
          action={{ label: 'Remove', icon: 'close', onClick: () => {} }}
        />
      </ul>
    )

    expect(container.querySelector('.people__role')).toBeInTheDocument()
    expect(container.querySelector('.people__tag select')).toBeNull()
  })

  // The row is 30px of avatar and two lines of ellipsised text, so a name long
  // enough to be cut off is a name nobody can read. Hovering gives it back.
  it('offers the full name and address as a title when they are cut off', () => {
    render(
      <ul>
        <PersonRow name="Aishwarya Deshpande" detail="aishwarya.deshpande@syncspace.test" />
      </ul>
    )

    expect(screen.getByText('Aishwarya Deshpande')).toHaveAttribute('title', 'Aishwarya Deshpande')
    expect(screen.getByText('aishwarya.deshpande@syncspace.test')).toHaveAttribute(
      'title',
      'aishwarya.deshpande@syncspace.test'
    )
  })

  it('renders no control slot at all for somebody with nothing to change', () => {
    const { container } = render(
      <ul>
        <PersonRow name="Priya R" detail="Joined by link" />
      </ul>
    )

    expect(container.querySelector('.people__controls')).toBeNull()
  })
})

describe('RoleSelect', () => {
  it('falls back to a plain tag when there is nothing this person may assign', () => {
    const { container } = render(<RoleSelect value="owner" options={[]} labels={LABELS} />)

    expect(container.querySelector('select')).toBeNull()
    expect(container.querySelector('.people__tag')).toHaveTextContent('Owner')
  })

  it('reports the role that was picked', async () => {
    const onChange = vi.fn()
    render(<RoleSelect value="editor" options={['admin', 'editor', 'viewer']} onChange={onChange} labels={LABELS} />)

    await userEvent.selectOptions(screen.getByLabelText('Role'), 'viewer')
    expect(onChange).toHaveBeenCalledWith('viewer')
  })
})

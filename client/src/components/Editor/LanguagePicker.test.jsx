import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { LanguagePicker } from './LanguagePicker.jsx'
import { useUIStore } from '../../store/uiStore.js'

const open = async (user) => {
  await user.click(screen.getByRole('button', { name: /Editor language/ }))
  return screen.getByRole('textbox')
}

const names = () => screen.getAllByRole('option').map((node) => node.textContent.replace('recent', ''))

describe('LanguagePicker', () => {
  it('puts the exact match first, not whichever name comes first alphabetically', async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)

    await user.type(await open(user), 'java')

    // javascript also contains "java" — but java is what was asked for.
    expect(names()[0]).toBe('java')
    expect(names()).toContain('javascript')
  })

  it('Enter takes the top match, which is therefore the exact one', async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)

    await user.type(await open(user), 'java')
    await user.keyboard('{Enter}')

    expect(useUIStore.getState().language).toBe('java')
  })

  it('ranks a prefix above a mere substring', async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)

    await user.type(await open(user), 'ty')

    // typescript starts with it; python only contains it.
    expect(names()[0]).toBe('typescript')
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    render(<LanguagePicker />)

    await user.type(await open(user), 'cobol')

    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/No language matches/)).toBeInTheDocument()
  })
})

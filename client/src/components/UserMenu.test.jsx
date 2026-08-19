import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { UserMenu } from './UserMenu.jsx'
import { AuthProvider } from '../auth/AuthProvider.jsx'
import { ToastProvider } from './ui/ToastProvider.jsx'
import { setAuthToken } from '../api/client.js'

const USER = { id: 'u1', email: 'alice@syncspace.test', name: 'Alice' }

const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
})

function renderMenu() {
  return render(
    <MemoryRouter initialEntries={['/room/abc']}>
      <ToastProvider>
        <AuthProvider>
          <Routes>
            <Route path="/room/:roomId" element={<UserMenu />} />
            <Route path="/login" element={<h1>Sign in page</h1>} />
            <Route path="/dashboard" element={<h1>Dashboard page</h1>} />
          </Routes>
        </AuthProvider>
      </ToastProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  setAuthToken(null)
  localStorage.clear()
})

describe('UserMenu', () => {
  it('offers sign out to a signed-in user and clears the session', async () => {
    localStorage.setItem('syncspace:token', 'stored-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: USER }))

    renderMenu()
    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /Alice/ }))
    const signOut = await screen.findByRole('menuitem', { name: 'Sign out' })

    await userEvent.click(signOut)

    // The token is gone and the app has moved to the sign-in route.
    await waitFor(() => expect(localStorage.getItem('syncspace:token')).toBeNull())
    expect(await screen.findByRole('heading', { name: 'Sign in page' })).toBeInTheDocument()
  })

  it('shows the account email inside the menu', async () => {
    localStorage.setItem('syncspace:token', 'stored-token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ user: USER }))

    renderMenu()
    await waitFor(() => expect(screen.getByRole('button', { name: /Alice/ })).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /Alice/ }))

    expect(screen.getByText('alice@syncspace.test')).toBeInTheDocument()
  })

  it('offers sign-in rather than sign-out to a guest', async () => {
    renderMenu()

    const trigger = await screen.findByRole('button', { name: /Guest-/ })
    await userEvent.click(trigger)

    expect(screen.getByRole('menuitem', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(screen.getByText('Guest session')).toBeInTheDocument()
  })

  it('closes on Escape', async () => {
    renderMenu()
    const trigger = await screen.findByRole('button', { name: /Guest-/ })

    await userEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()

    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
  })
})

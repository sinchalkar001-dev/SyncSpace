import { describe, expect, it } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ToastProvider } from './ToastProvider.jsx'
import { useToast } from './useToast.js'

function Probe() {
  const toast = useToast()
  return (
    <div>
      <button onClick={() => toast.success('Saved')}>notify</button>
      <button onClick={() => toast.error('Connection lost')}>fail</button>
    </div>
  )
}

const renderProbe = () =>
  render(
    <ToastProvider>
      <Probe />
    </ToastProvider>
  )

describe('ToastProvider', () => {
  it('shows a message and lets the user dismiss it', async () => {
    renderProbe()
    await userEvent.click(screen.getByRole('button', { name: 'notify' }))

    expect(await screen.findByText('Saved')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    await waitFor(() => expect(screen.queryByText('Saved')).not.toBeInTheDocument())
  })

  it('announces errors assertively so they are not missed', async () => {
    renderProbe()
    await userEvent.click(screen.getByRole('button', { name: 'fail' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Connection lost')
  })

  it('stacks multiple messages', async () => {
    renderProbe()
    await userEvent.click(screen.getByRole('button', { name: 'notify' }))
    await userEvent.click(screen.getByRole('button', { name: 'fail' }))

    expect(await screen.findByText('Saved')).toBeInTheDocument()
    expect(screen.getByText('Connection lost')).toBeInTheDocument()
  })
})

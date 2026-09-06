import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RunPanel } from './RunPanel.jsx'

/**
 * The console under the editor.
 *
 * Two things here are not decoration. A program stopped for using too much
 * memory must not read as a crash — the fix for one is a smaller allocation
 * and the fix for the other is a bug hunt, and "Exited with 137" sends
 * somebody looking for the wrong thing. And a server that cannot contain a
 * program has to say so where the person about to run a stranger's code will
 * see it, because the alternative is reading the deployment's environment
 * variables, which they cannot do.
 */

const finished = (over = {}) => ({
  stdout: '',
  stderr: '',
  exitCode: 0,
  stage: 'run',
  durationMs: 40,
  state: 'completed',
  termination: 'exited',
  ...over,
})

const renderPanel = (props = {}) =>
  render(<RunPanel status="idle" result={null} error={null} onClose={() => {}} onClear={() => {}} {...props} />)

describe('how a finished run is summarised', () => {
  it('says it finished, with how long it took', () => {
    renderPanel({ result: finished({ stdout: 'hi\n' }) })
    expect(screen.getByText(/Finished in/)).toBeInTheDocument()
  })

  /** The distinction that sends somebody to the right fix. */
  it('calls running out of memory what it is, not a crash', () => {
    renderPanel({ result: finished({ state: 'resource_limit', termination: 'memory_limit', exitCode: 137 }) })

    expect(screen.getByText('Ran out of memory')).toBeInTheDocument()
    expect(screen.queryByText(/Exited with/)).not.toBeInTheDocument()
  })

  it('explains a program stopped for printing too much', () => {
    renderPanel({ result: finished({ state: 'resource_limit', termination: 'output_limit', exitCode: null }) })
    expect(screen.getByText(/printing too much/)).toBeInTheDocument()
  })

  it('explains a fork bomb rather than reporting a signal', () => {
    renderPanel({ result: finished({ state: 'resource_limit', termination: 'process_limit', exitCode: null }) })
    expect(screen.getByText(/too many processes/)).toBeInTheDocument()
  })

  it('says a cancelled run was stopped', () => {
    renderPanel({ result: finished({ state: 'cancelled', termination: 'cancelled', exitCode: null }) })
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('still reads a result from a server that sends none of this', () => {
    // An older server, or a broadcast from before the upgrade. Rendering
    // nothing would be a worse answer than the one we used to give.
    renderPanel({ result: { stdout: 'hi\n', exitCode: 1, stage: 'run', durationMs: 12 } })
    expect(screen.getByText('Exited with 1')).toBeInTheDocument()
  })
})

describe('a run still going', () => {
  const live = (over = {}) => ({ executionId: 'exec-1', state: 'running', mine: true, ...over })

  it('says it is queued while it waits for a slot', () => {
    renderPanel({ status: 'running', live: live({ state: 'queued' }) })
    expect(screen.getByText('Queued')).toBeInTheDocument()
  })

  it('names whoever else in the room is running something', () => {
    renderPanel({ live: live({ mine: false, by: { name: 'Priya' } }) })
    expect(screen.getByText('Priya is running this')).toBeInTheDocument()
  })

  it('offers to stop it', async () => {
    const onCancel = vi.fn()
    renderPanel({ status: 'running', live: live(), onCancel })

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  /** Before the server has named the run there is no id to cancel. */
  it('offers no Cancel until the run has an id', () => {
    renderPanel({ status: 'running', live: live({ executionId: null }), onCancel: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })

  it('says so while the stop is in flight, and will not send it twice', () => {
    renderPanel({ status: 'running', live: live(), cancelling: true, onCancel: vi.fn() })

    const button = screen.getByRole('button', { name: 'Stopping…' })
    expect(button).toBeDisabled()
  })

  it('offers nothing to cancel once there is nothing running', () => {
    renderPanel({ result: finished(), onCancel: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
  })
})

describe('what the server admits about isolation', () => {
  it('warns when programs are not contained', () => {
    renderPanel({ isolation: { backend: 'process', weak: true, unenforced: ['network'] } })

    expect(screen.getByText(/run unsandboxed on this server/)).toBeInTheDocument()
  })

  it('says nothing when they are', () => {
    renderPanel({ isolation: { backend: 'docker', weak: false, unenforced: [] } })

    expect(screen.queryByText(/unsandboxed/)).not.toBeInTheDocument()
  })

  /** A standing property of the deployment, not a running commentary. */
  it('keeps quiet while a program is actually running', () => {
    renderPanel({
      status: 'running',
      live: { executionId: 'exec-1', state: 'running', mine: true },
      isolation: { backend: 'process', weak: true, unenforced: ['network'] },
    })

    expect(screen.queryByText(/unsandboxed/)).not.toBeInTheDocument()
  })
})

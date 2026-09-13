import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CopilotPanel } from './CopilotPanel.jsx'

/**
 * The panel, driven by a stubbed hook.
 *
 * What is being checked is the behaviour that makes it a tool rather than a
 * chat window: that it offers what fits what you are doing, that a button it
 * will not run says why instead of sitting there greyed and silent, and that
 * nothing it proposes can be applied without somebody pressing a second
 * button.
 */

const ACTIONS = [
  { id: 'whiteboard.explain', context: 'whiteboard', title: 'Explain architecture', detail: 'What the diagram says', icon: 'layers', sources: ['architecture'], produces: ['answer'], needs: null, apply: null },
  { id: 'whiteboard.generate.code', context: 'whiteboard', title: 'Generate code', detail: 'A first implementation', icon: 'zap', sources: ['architecture'], produces: ['answer', 'files'], needs: null, apply: 'files' },
  { id: 'code.explain', context: 'code', title: 'Explain selection', detail: 'What the highlighted code does', icon: 'search', sources: ['selection'], produces: ['answer'], needs: 'selection', apply: null },
  { id: 'code.review', context: 'code', title: 'Review', detail: 'The review a colleague would give', icon: 'eye', sources: ['code', 'selection'], produces: ['answer', 'findings'], needs: null, apply: null },
  { id: 'execution.diagnose', context: 'execution', title: 'Diagnose failure', detail: 'The cause, not the symptom', icon: 'search', sources: ['run'], produces: ['answer'], needs: null, apply: null },
  { id: 'replay.moment', context: 'replay', title: 'Explain this moment', detail: 'What was happening', icon: 'clock', sources: ['moment'], produces: ['answer'], needs: 'seq', apply: null },
  { id: 'room.summary', context: 'room', title: 'Summarize session', detail: 'What this room produced', icon: 'file', sources: ['timeline'], produces: ['answer'], needs: null, apply: null },
]

const CONTEXTS = [
  { id: 'whiteboard', label: 'Whiteboard', icon: 'pen', detail: 'The design on the board' },
  { id: 'code', label: 'Code', icon: 'code', detail: 'The shared buffer' },
  { id: 'execution', label: 'Runs', icon: 'play', detail: 'What happened when it ran' },
  { id: 'replay', label: 'Replay', icon: 'clock', detail: 'The history' },
  { id: 'room', label: 'Room', icon: 'grid', detail: 'The session as a whole' },
]

const idle = { state: 'idle', text: '', run: null, error: null, action: null, sources: [] }

function stubCopilot(overrides = {}) {
  return {
    catalogue: {
      state: 'ready',
      data: { enabled: true, allowed: true, reason: null, runs: 0, contexts: CONTEXTS, actions: ACTIONS },
      error: null,
    },
    current: idle,
    history: [],
    selected: new Set(),
    busy: null,
    ask: vi.fn(),
    stop: vi.fn(),
    open: vi.fn(),
    toggle: vi.fn(),
    setAll: vi.fn(),
    applyFiles: vi.fn(),
    applyCode: vi.fn(),
    rejectCode: vi.fn(),
    clear: vi.fn(),
    noteRemote: vi.fn(),
    ...overrides,
  }
}

const show = ({ copilot = stubCopilot(), ...props } = {}) => {
  render(
    <CopilotPanel
      open
      onOpenChange={() => {}}
      signedIn
      paneMode="split"
      selection={null}
      replay={{ open: false }}
      lastRun={null}
      hasRuns={false}
      focusedSurface={null}
      buffer={null}
      {...props}
      copilot={copilot}
    />
  )
  return copilot
}

describe('following what you are doing', () => {
  it('offers the board’s actions when the board is what is on screen', () => {
    show({ paneMode: 'board' })

    expect(screen.getByRole('button', { name: /Explain architecture/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Explain selection/ })).not.toBeInTheDocument()
  })

  it('moves to the code the moment something is selected', () => {
    show({ paneMode: 'board', selection: { startLine: 4, endLine: 9 } })

    expect(screen.getByRole('button', { name: /Explain selection/ })).toBeInTheDocument()
  })

  it('moves to the runs after a failure', () => {
    show({ paneMode: 'code', lastRun: { ok: false, at: Date.now(), executionId: 'x1' }, hasRuns: true })

    expect(screen.getByRole('button', { name: /Diagnose failure/ })).toBeInTheDocument()
  })

  it('lets a replay take over', () => {
    show({ paneMode: 'code', replay: { open: true, seq: 12 } })

    expect(screen.getByRole('button', { name: /Explain this moment/ })).toBeInTheDocument()
  })

  /**
   * Guessing is fine. Guessing and then refusing to be corrected is not.
   */
  it('lets somebody override what it guessed', async () => {
    const user = userEvent.setup()
    show({ paneMode: 'board' })

    await user.click(screen.getByRole('button', { name: /^Room/ }))

    expect(screen.getByRole('button', { name: /Summarize session/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Explain architecture/ })).not.toBeInTheDocument()
  })

  it('marks which context it worked out for itself', () => {
    show({ paneMode: 'board' })

    const board = screen.getByRole('button', { name: /Whiteboard/ })
    expect(board).toHaveAttribute('aria-pressed', 'true')
    expect(within(board).getByTitle(/Picked up from what you are doing/)).toBeInTheDocument()
  })
})

describe('why a button will not run', () => {
  /** A disabled control that does not say why is worse than one that fails. */
  it('says what it needs instead of sitting there greyed out', () => {
    show({ paneMode: 'code', selection: null })

    const explain = screen.getByRole('button', { name: /Explain selection/ })
    expect(explain).toBeDisabled()
    expect(explain).toHaveAccessibleName(/Select some code first/)
  })

  it('leaves an action that does not need a selection alone', () => {
    show({ paneMode: 'code', selection: null })

    expect(screen.getByRole('button', { name: /Review/ })).toBeEnabled()
  })

  it('says there is nothing to look at when nothing has ever run', async () => {
    const user = userEvent.setup()
    show({ paneMode: 'code', hasRuns: false })

    // Chosen deliberately, since nothing has failed to move the context here.
    await user.click(screen.getByRole('button', { name: /^Runs/ }))

    const diagnose = screen.getByRole('button', { name: /Diagnose failure/ })
    expect(diagnose).toBeDisabled()
    expect(diagnose).toHaveAccessibleName(/Run the code first/)
  })

  /** The same room after a page reload: the runs are still there to ask about. */
  it('offers the run actions when the room has runs from before this visit', async () => {
    const user = userEvent.setup()
    show({ paneMode: 'code', hasRuns: true, lastRun: null })

    await user.click(screen.getByRole('button', { name: /^Runs/ }))

    expect(screen.getByRole('button', { name: /Diagnose failure/ })).toBeEnabled()
  })

  it('asks a guest to sign in rather than hiding the feature', () => {
    show({ signedIn: false, paneMode: 'board' })

    expect(screen.getByRole('button', { name: /Explain architecture/ })).toHaveAccessibleName(
      /Sign in/
    )
  })

  it('explains a deployment with no model, and offers nothing', () => {
    const copilot = stubCopilot({
      catalogue: {
        state: 'ready',
        data: {
          enabled: false,
          allowed: false,
          reason: 'No model key is configured, so this server cannot reach a model.',
          contexts: CONTEXTS,
          actions: ACTIONS,
        },
        error: null,
      },
    })

    show({ copilot })

    expect(screen.getByText(/The copilot is not available here/)).toBeInTheDocument()
    expect(screen.getByText(/No model key is configured/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Explain architecture/ })).not.toBeInTheDocument()
  })
})

describe('asking', () => {
  it('sends the selection along with an action that only supplements with one', async () => {
    const user = userEvent.setup()
    const copilot = stubCopilot()

    show({ copilot, paneMode: 'code', selection: { startLine: 4, endLine: 9 } })
    await user.click(screen.getByRole('button', { name: /Review/ }))

    expect(copilot.ask).toHaveBeenCalledWith({
      action: 'code.review',
      startLine: 4,
      endLine: 9,
    })
  })

  it('carries what somebody typed into the note', async () => {
    const user = userEvent.setup()
    const copilot = stubCopilot()

    show({ copilot, paneMode: 'board' })
    await user.type(screen.getByLabelText(/Anything to add/), 'focus on the queue')
    await user.click(screen.getByRole('button', { name: /Explain architecture/ }))

    expect(copilot.ask).toHaveBeenCalledWith({
      action: 'whiteboard.explain',
      note: 'focus on the queue',
    })
  })

  it('marks the actions that can propose a change, not just advise', () => {
    show({ paneMode: 'board' })

    const generate = screen.getByRole('button', { name: /Generate code/ })
    expect(within(generate).getByTitle(/Can propose files/)).toBeInTheDocument()

    const explain = screen.getByRole('button', { name: /Explain architecture/ })
    expect(within(explain).queryByTitle(/Can propose/)).not.toBeInTheDocument()
  })
})

describe('an answer', () => {
  const streaming = {
    state: 'streaming',
    text: 'The parser does not handle ',
    run: null,
    error: null,
    action: 'code.review',
    sources: [
      { key: 'code', label: 'Shared code buffer', detail: '84 lines', present: true },
      { key: 'selection', label: 'Your selection', detail: 'nothing recorded yet', present: false },
    ],
  }

  /** The sources are on screen before the answer, not after it. */
  it('shows what it is reading while it reads it', () => {
    show({ copilot: stubCopilot({ current: streaming }) })

    expect(screen.getByText('Shared code buffer')).toBeInTheDocument()
    expect(screen.getByText('84 lines')).toBeInTheDocument()
    expect(screen.getByText('The parser does not handle')).toBeInTheDocument()
  })

  /**
   * A source that found nothing keeps its chip. Dropping it would leave a
   * reader assuming the answer was based on it.
   */
  it('says which sources it read and found empty', () => {
    show({ copilot: stubCopilot({ current: streaming }) })

    expect(screen.getByText('Your selection')).toBeInTheDocument()
    expect(screen.getByText('empty')).toBeInTheDocument()
  })

  it('offers a way to stop an answer that is still arriving', async () => {
    const user = userEvent.setup()
    const copilot = stubCopilot({ current: streaming })

    show({ copilot })
    await user.click(screen.getByRole('button', { name: 'Stop' }))

    expect(copilot.stop).toHaveBeenCalled()
  })

  it('shows findings worst first, with what each one rests on', () => {
    const copilot = stubCopilot({
      current: {
        ...streaming,
        state: 'done',
        run: {
          id: 'r1',
          actionId: 'code.review',
          answer: 'Two problems.',
          sources: streaming.sources,
          result: {
            findings: [
              { title: 'A naming nit', detail: null, severity: 'low', evidence: [] },
              { title: 'Unchecked index', detail: 'Crashes on an empty list.', severity: 'high', evidence: ['line 12'] },
            ],
          },
          files: [],
          patch: null,
          rejected: [],
          discarded: 0,
        },
      },
    })

    show({ copilot })

    const findings = screen.getAllByText(/Unchecked index|A naming nit/)
    expect(findings[0]).toHaveTextContent('Unchecked index')
    expect(screen.getByText(/line 12/)).toBeInTheDocument()
  })

  it('says when citations were dropped for naming events that never happened', () => {
    const copilot = stubCopilot({
      current: {
        ...streaming,
        state: 'done',
        run: {
          id: 'r1',
          actionId: 'room.summary',
          answer: 'A summary.',
          sources: [],
          result: { citations: [] },
          files: [],
          patch: null,
          rejected: [],
          discarded: 2,
        },
      },
    })

    show({ copilot })

    expect(screen.getByText(/2 citations were dropped/)).toBeInTheDocument()
  })
})

describe('nothing is applied without being asked for', () => {
  const withPatch = (baseText, contents) => ({
    id: 'r1',
    actionId: 'execution.fix',
    answer: 'The minus should be a plus.',
    sources: [],
    result: {},
    files: [],
    patch: { contents, rationale: 'add() was subtracting', baseText, status: 'proposed' },
    rejected: [],
    discarded: 0,
  })

  const bufferOf = (text) => ({ toString: () => text })

  it('shows the change as lines, and applies nothing until asked', async () => {
    const user = userEvent.setup()
    const run = withPatch('return a - b', 'return a + b')
    const copilot = stubCopilot({
      current: { state: 'done', text: '', run, error: null, action: 'execution.fix', sources: [] },
    })

    show({ copilot, buffer: bufferOf('return a - b') })

    expect(screen.getByText('return a - b')).toBeInTheDocument()
    expect(screen.getByText('return a + b')).toBeInTheDocument()
    expect(copilot.applyCode).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: /Apply to the code/ }))
    expect(copilot.applyCode).toHaveBeenCalled()
  })

  /**
   * Said before the button is pressed. Somebody can see the code changing
   * beside them, and a warning that only appeared on rejection would read as
   * the feature being broken.
   */
  it('refuses up front when the code has moved on', () => {
    const run = withPatch('return a - b', 'return a + b')
    const copilot = stubCopilot({
      current: { state: 'done', text: '', run, error: null, action: 'execution.fix', sources: [] },
    })

    show({ copilot, buffer: bufferOf('return a - b // edited since') })

    expect(screen.getByRole('button', { name: /Apply to the code/ })).toBeDisabled()
    expect(screen.getByText(/code has changed since this was written/)).toBeInTheDocument()
  })

  it('lets a change be turned down without touching the buffer', async () => {
    const user = userEvent.setup()
    const run = withPatch('return a - b', 'return a + b')
    const copilot = stubCopilot({
      current: { state: 'done', text: '', run, error: null, action: 'execution.fix', sources: [] },
    })

    show({ copilot, buffer: bufferOf('return a - b') })
    await user.click(screen.getByRole('button', { name: /Turn down/ }))

    expect(copilot.rejectCode).toHaveBeenCalled()
    expect(copilot.applyCode).not.toHaveBeenCalled()
  })

  it('says plainly when a decision has already been made', () => {
    const run = withPatch('return a - b', 'return a + b')
    run.patch.status = 'stale'

    const copilot = stubCopilot({
      current: { state: 'done', text: '', run, error: null, action: 'execution.fix', sources: [] },
    })

    show({ copilot, buffer: bufferOf('anything') })

    expect(screen.getByText(/the code had moved on/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Apply to the code/ })).not.toBeInTheDocument()
  })

  it('records a decision for every file, including the ones turned down', async () => {
    const user = userEvent.setup()
    const run = {
      id: 'r1',
      actionId: 'code.tests',
      answer: 'Two files.',
      sources: [],
      result: {},
      files: [
        { id: 'f1', path: 'a.test.js', action: 'create', contents: 'x', size: 1, status: 'proposed' },
        { id: 'f2', path: 'b.test.js', action: 'create', contents: 'y', size: 1, status: 'proposed' },
      ],
      patch: null,
      rejected: [],
      discarded: 0,
    }

    const copilot = stubCopilot({
      current: { state: 'done', text: '', run, error: null, action: 'code.tests', sources: [] },
      selected: new Set(['f1']),
    })

    show({ copilot })

    expect(screen.getByText(/1 of 2 will be written/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Apply 1/ }))
    expect(copilot.applyFiles).toHaveBeenCalled()
  })

  it('calls an empty decision what it is', () => {
    const run = {
      id: 'r1',
      actionId: 'code.tests',
      answer: 'One file.',
      sources: [],
      result: {},
      files: [
        { id: 'f1', path: 'a.test.js', action: 'create', contents: 'x', size: 1, status: 'proposed' },
      ],
      patch: null,
      rejected: [],
      discarded: 0,
    }

    show({
      copilot: stubCopilot({
        current: { state: 'done', text: '', run, error: null, action: 'code.tests', sources: [] },
        selected: new Set(),
      }),
    })

    expect(screen.getByRole('button', { name: /Turn all down/ })).toBeInTheDocument()
    expect(screen.getByText(/records the whole change set as turned down/)).toBeInTheDocument()
  })
})

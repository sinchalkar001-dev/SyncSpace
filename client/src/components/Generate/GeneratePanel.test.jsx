import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderHook, act } from '@testing-library/react'
import { GeneratePanel } from './GeneratePanel.jsx'
import { ChangeSetReview } from './ChangeSetReview.jsx'
import { ArchitecturePreview } from './ArchitecturePreview.jsx'
import { ToastProvider } from '../ui/ToastProvider.jsx'
import { useGeneration } from '../../hooks/useGeneration.js'
import { setAuthToken } from '../../api/client.js'

/**
 * Generate from whiteboard, as a person meets it.
 *
 * The two things worth guarding are not about the model at all. The reading of
 * the board has to be shown *before* anything is generated, because it is
 * inferred from geometry and is sometimes wrong — and nothing may be written
 * without being ticked, because a change set that applied itself would be a
 * very expensive way to lose somebody's files.
 */

const GRAPH = {
  nodes: [
    { id: 'n1', key: 'client', type: 'client', label: 'Client', description: null, shape: 'rect' },
    { id: 'n2', key: 'api', type: 'api', label: 'API', description: null, shape: 'rect' },
    { id: 'n3', key: 'database', type: 'datastore', label: 'Database', description: null, shape: 'rect' },
  ],
  edges: [
    { id: 'e1', source: 'client', target: 'api', directed: true, relationship: null },
    { id: 'e2', source: 'api', target: 'database', directed: true, relationship: 'reads/writes' },
  ],
  notes: [],
  warnings: [],
}

const AI = {
  enabled: true,
  model: 'claude-sonnet-5',
  reason: null,
  targets: [
    { key: 'backend', description: 'Server-side services' },
    { key: 'api', description: 'HTTP routes' },
    { key: 'database', description: 'Models' },
    { key: 'frontend', description: 'Scaffolding' },
  ],
}

const CHANGE_SET = {
  id: 'g1',
  status: 'succeeded',
  summary: 'A three-tier web application.',
  targets: ['backend'],
  requestedByName: 'Ada',
  model: 'claude-sonnet-5',
  counts: { create: 2, modify: 1, delete: 0, applied: 0, rejected: 0, total: 3 },
  architecture: GRAPH,
  plan: [{ step: 'Model the data', detail: 'Start with the schema' }],
  assumptions: ['PostgreSQL, because the diagram says only "Database"'],
  questions: ['Which identity provider should Auth use?'],
  rejected: [],
  files: [
    { id: 'f1', path: 'src/models/user.js', action: 'create', contents: 'export const User = {}\n', rationale: 'The user record', size: 23, status: 'proposed', previous: null },
    { id: 'f2', path: 'src/api/index.js', action: 'create', contents: 'export const routes = []\n', rationale: null, size: 25, status: 'proposed', previous: null },
    { id: 'f3', path: 'src/db.js', action: 'modify', contents: 'export const db = 2\n', rationale: null, size: 20, status: 'proposed', previous: 'export const db = 1\n' },
  ],
}

let calls

function mockApi({ ai = AI, architecture = GRAPH, generation = CHANGE_SET, apply } = {}) {
  calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init = {}) => {
    const method = init.method || 'GET'
    const path = String(url)
    calls.push({ method, path, body: init.body ? JSON.parse(init.body) : null })

    const ok = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })

    if (path.endsWith('/ai')) return ok(ai)
    if (path.endsWith('/architecture')) return ok({ architecture })
    if (path.endsWith('/generations')) return ok({ generations: [] })
    if (path.endsWith('/apply')) {
      return ok(apply ?? { generation: CHANGE_SET, applied: 0, rejected: 0, failed: 0 })
    }
    if (path.endsWith('/generate')) {
      return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ generation }) })
    }
    return ok({})
  })
}

/** Drives the real hook, so the panel is exercised the way the room uses it. */
function Harness({ roomId = 'r1' }) {
  const state = useGeneration(roomId, { enabled: true })
  return <GeneratePanel open onClose={() => {}} generation={state} />
}

const renderPanel = () =>
  render(
    <ToastProvider>
      <Harness />
    </ToastProvider>
  )

/**
 * The node labels only.
 *
 * A node called "Client" is also of type client, so its badge carries the same
 * word — reading the list by text alone finds both and proves nothing about
 * which the component actually rendered.
 */
const nodeLabels = () =>
  [...document.querySelectorAll('.arch__label')].map((element) => element.textContent)

beforeEach(() => setAuthToken('t'))
afterEach(() => vi.restoreAllMocks())

describe('before generating', () => {
  it('shows what the server read off the board', async () => {
    mockApi()
    renderPanel()

    expect(await screen.findByText(/what the board says/i)).toBeInTheDocument()
    expect(nodeLabels()).toEqual(['Client', 'API', 'Database'])
    expect(screen.getByText(/3 components · 2 connections/)).toBeInTheDocument()
  })

  it('shows the connections, and the relationship written on one', async () => {
    mockApi()
    renderPanel()

    await screen.findByText(/what the board says/i)
    expect(screen.getByText('reads/writes')).toBeInTheDocument()
  })

  /**
   * The reading is geometric and can be wrong. Showing it costs one cheap
   * request and saves a paid one against a diagram nobody understood.
   */
  it('reads the board without generating anything', async () => {
    mockApi()
    renderPanel()

    await screen.findByText(/what the board says/i)
    expect(calls.some((call) => call.path.endsWith('/architecture'))).toBe(true)
    expect(calls.some((call) => call.path.endsWith('/generate'))).toBe(false)
  })

  it('passes on what the diagram could not say', async () => {
    mockApi({
      architecture: {
        ...GRAPH,
        warnings: [
          { code: 'dangling_connector', message: 'An arrow does not reach a box at its head.', shapeId: 'x' },
        ],
      },
    })
    renderPanel()

    expect(await screen.findByText(/does not reach a box/i)).toBeInTheDocument()
    expect(screen.getByText(/what could not be read/i)).toBeInTheDocument()
  })

  it('explains an empty board instead of offering to generate from it', async () => {
    mockApi({ architecture: { nodes: [], edges: [], notes: [], warnings: [] } })
    renderPanel()

    expect(await screen.findByText(/nothing to read yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Generate' })).toBeDisabled()
  })

  /** A feature that is off should say so where somebody looks for it. */
  it('says why generation is unavailable rather than failing on the press', async () => {
    mockApi({
      ai: { enabled: false, model: null, reason: 'No ANTHROPIC_API_KEY is configured.', targets: [] },
    })
    renderPanel()

    expect(await screen.findByText(/no anthropic_api_key/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate' })).not.toBeInTheDocument()
    // The board reading still works: it needs no model.
    expect(nodeLabels()).toContain('Client')
  })

  it('sends the chosen targets and the extra instructions', async () => {
    mockApi()
    const user = userEvent.setup()
    renderPanel()

    await screen.findByText(/what the board says/i)

    await user.click(screen.getByLabelText(/frontend/i, { selector: 'input' }))
    await user.type(screen.getByRole('textbox'), 'Express and Mongoose')
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/generate'))).toBe(true))
    const request = calls.find((call) => call.path.endsWith('/generate'))
    expect(request.body.targets).toContain('frontend')
    expect(request.body.intent).toBe('Express and Mongoose')
  })
})

describe('reviewing the change set', () => {
  const openReview = async () => {
    const user = userEvent.setup()
    renderPanel()
    await screen.findByText(/what the board says/i)
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('A three-tier web application.')
    return user
  }

  it('groups the files by what they would do', async () => {
    mockApi()
    await openReview()

    expect(screen.getByText(/files to create/i)).toBeInTheDocument()
    expect(screen.getByText(/files to modify/i)).toBeInTheDocument()
    expect(screen.queryByText(/files to delete/i)).not.toBeInTheDocument()
  })

  it('puts the assumptions and the gaps in front of the code', async () => {
    mockApi()
    await openReview()

    expect(screen.getByText(/postgresql, because the diagram/i)).toBeInTheDocument()
    expect(screen.getByText(/which identity provider/i)).toBeInTheDocument()
  })

  it('shows what a modification would replace', async () => {
    mockApi()
    const user = await openReview()

    const row = screen.getByText('src/db.js').closest('li')
    await user.click(within(row).getByRole('button', { name: /view/i }))

    expect(within(row).getByText(/this would replace/i)).toBeInTheDocument()
    expect(within(row).getByText('export const db = 1')).toBeInTheDocument()
    expect(within(row).getByText('export const db = 2')).toBeInTheDocument()
  })

  /** Nothing is written by generating. Applying is a separate, explicit act. */
  it('writes nothing until Apply is pressed', async () => {
    mockApi()
    await openReview()

    expect(calls.some((call) => call.path.endsWith('/apply'))).toBe(false)
    expect(screen.getByRole('button', { name: /apply 3/i })).toBeInTheDocument()
  })

  it('applies only what is still ticked', async () => {
    mockApi()
    const user = await openReview()

    await user.click(screen.getByLabelText('Accept src/api/index.js'))
    expect(screen.getByRole('button', { name: /apply 2/i })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /apply 2/i }))

    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/apply'))).toBe(true))
    const request = calls.find((call) => call.path.endsWith('/apply'))
    expect(request.body.accept).toEqual(['f1', 'f3'])
  })

  it('lets everything be turned down at once, and says what that means', async () => {
    mockApi()
    const user = await openReview()

    await user.click(screen.getByRole('button', { name: 'Select none' }))

    expect(screen.getByText(/record the whole change set as rejected/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /reject all/i }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/apply'))).toBe(true))
    expect(calls.find((call) => call.path.endsWith('/apply')).body.accept).toEqual([])
  })

  it('reports a file that could not be applied against that file', async () => {
    const applied = {
      ...CHANGE_SET,
      files: [
        { ...CHANGE_SET.files[0], status: 'applied' },
        { ...CHANGE_SET.files[1], status: 'rejected' },
        { ...CHANGE_SET.files[2], error: 'Only the uploader or room owner can delete files' },
      ],
    }
    mockApi({ apply: { generation: applied, applied: 1, rejected: 1, failed: 1 } })
    const user = await openReview()

    await user.click(screen.getByRole('button', { name: /apply 3/i }))

    expect(await screen.findByText(/only the uploader or room owner/i)).toBeInTheDocument()
    expect(screen.getByText('Applied')).toBeInTheDocument()
  })
})

describe('ArchitecturePreview on its own', () => {
  it('offers a retry when the board could not be read', async () => {
    const onRetry = vi.fn()
    render(<ArchitecturePreview state="error" error="Could not reach the server." onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server.')
    await userEvent.click(screen.getByRole('button', { name: /read the board again/i }))
    expect(onRetry).toHaveBeenCalled()
  })

  /** An arrow was drawn with a direction; a plain line was not. */
  it('does not claim a direction a plain line never had', () => {
    render(
      <ArchitecturePreview
        state="ready"
        graph={{
          ...GRAPH,
          edges: [{ id: 'e1', source: 'a', target: 'b', directed: false, relationship: null }],
        }}
        onRetry={() => {}}
      />
    )

    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByText('→')).not.toBeInTheDocument()
  })
})

describe('ChangeSetReview on its own', () => {
  it('says a reviewed change set is done rather than offering Apply again', () => {
    render(
      <ChangeSetReview
        generation={{
          ...CHANGE_SET,
          files: CHANGE_SET.files.map((file) => ({ ...file, status: 'applied' })),
        }}
        selected={new Set()}
        busy={null}
        onToggle={() => {}}
        onSetAll={() => {}}
        onApply={() => {}}
        onBack={() => {}}
      />
    )

    expect(screen.getByText(/reviewed/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^apply/i })).not.toBeInTheDocument()
  })

  it('explains a change set that produced no files', () => {
    render(
      <ChangeSetReview
        generation={{ ...CHANGE_SET, files: [], counts: { ...CHANGE_SET.counts, total: 0 } }}
        selected={new Set()}
        busy={null}
        onToggle={() => {}}
        onSetAll={() => {}}
        onApply={() => {}}
        onBack={() => {}}
      />
    )

    expect(screen.getByText(/produced no files/i)).toBeInTheDocument()
  })
})

describe('useGeneration', () => {
  it('starts with every proposed file selected', async () => {
    mockApi()
    const { result } = renderHook(() => useGeneration('r1', { enabled: true }))

    await act(async () => {
      await result.current.generate({ targets: ['backend'] })
    })

    expect([...result.current.selected].sort()).toEqual(['f1', 'f2', 'f3'])
  })

  it('leaves an already-decided file out of the selection', async () => {
    mockApi({
      generation: {
        ...CHANGE_SET,
        files: [
          { ...CHANGE_SET.files[0], status: 'applied' },
          { ...CHANGE_SET.files[1] },
        ],
      },
    })
    const { result } = renderHook(() => useGeneration('r1', { enabled: true }))

    await act(async () => {
      await result.current.generate({ targets: ['backend'] })
    })

    expect([...result.current.selected]).toEqual(['f2'])
  })

  it('keeps the change set when a later request fails', async () => {
    mockApi()
    const { result } = renderHook(() => useGeneration('r1', { enabled: true }))

    await act(async () => {
      await result.current.generate({ targets: ['backend'] })
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { code: 'x', message: 'Apply failed' } }),
    })

    await act(async () => {
      await result.current.apply()
    })

    expect(result.current.error).toBe('Apply failed')
    expect(result.current.generation.id).toBe('g1')
  })
})

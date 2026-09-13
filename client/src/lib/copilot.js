/**
 * What the copilot should be offering, given what somebody is doing.
 *
 * All of it is pure, and deliberately so. "Which context am I in" and "why is
 * this button disabled" are the two decisions that make the panel feel like it
 * is paying attention or like it is guessing, and both are much easier to get
 * right — and to keep right — as functions with tests than as conditions
 * spread through a component.
 */

/** How long after a run finishes it is still the thing you are looking at. */
export const RUN_IS_RECENT_MS = 90_000

/**
 * Which of the five contexts the room is in.
 *
 * Ordered by how strong a signal each is, not by how the room is laid out.
 * Somebody who has highlighted code is asking about code whatever pane is
 * open; somebody watching a replay is asking about the history even though the
 * board is on screen behind it. The pane is the weakest signal and comes last,
 * which is why it is not simply a mapping from `paneMode`.
 *
 * A failed run is treated as a strong signal but a perishable one. For the
 * minute or so after something goes wrong, that is what the person is looking
 * at; an hour later it is history and the room is back to being about the
 * work. A successful run is never a strong enough signal to move the context —
 * people run code that works and carry on with what they were doing.
 */
export function detectContext({
  paneMode = 'split',
  hasSelection = false,
  replayOpen = false,
  lastRun = null,
  focusedSurface = null,
  now = Date.now(),
} = {}) {
  if (replayOpen) return 'replay'
  if (hasSelection) return 'code'

  if (lastRun && !lastRun.ok && lastRun.at && now - lastRun.at < RUN_IS_RECENT_MS) {
    return 'execution'
  }

  if (focusedSurface === 'code') return 'code'
  if (focusedSurface === 'board') return 'whiteboard'

  if (paneMode === 'code') return 'code'
  if (paneMode === 'board') return 'whiteboard'

  // Split view with nothing selected and nothing recently run: no surface is
  // being pointed at, so the room as a whole is the honest answer.
  return 'room'
}

/** The actions for one context, in the order the registry declares them. */
export const actionsIn = (actions, context) =>
  (actions ?? []).filter((action) => action.context === context)

/**
 * Why an action cannot be run right now, or null.
 *
 * Returned as a sentence rather than a boolean, because a disabled button that
 * does not say why is worse than one that fails — at least a failure explains
 * itself. Every one of these is the same refusal the server would give, worded
 * the same way, so pressing through to it would tell you nothing new.
 */
export function blockerFor(action, state = {}) {
  const {
    signedIn = false,
    enabled = true,
    allowed = true,
    reason = null,
    hasSelection = false,
    hasMoment = false,
    hasRange = false,
    hasRuns = false,
    busy = false,
  } = state

  if (!enabled) return reason ?? 'The copilot is switched off on this server.'
  if (!signedIn) return 'Sign in to use the copilot in this room.'
  if (!allowed) return reason ?? 'Your role in this room does not include the copilot.'

  if (action.needs === 'selection' && !hasSelection) {
    return 'Select some code first — this one is about what you have highlighted.'
  }
  if (action.needs === 'seq' && !hasMoment) {
    return 'Pause the replay somewhere first — this one is about a point in the history.'
  }
  if (action.needs === 'range' && !hasRange) {
    return 'Choose two points in the history first — this one compares them.'
  }
  if (action.context === 'execution' && !hasRuns) {
    return 'Run the code first — there is nothing to look at yet.'
  }

  if (busy) return 'Wait for the current answer to finish.'

  return null
}

/** The input a run needs, built from what the room currently knows. */
export function inputFor(action, state = {}) {
  const input = { action: action.id }

  if (state.note) input.note = state.note

  // Sent whenever there is one, not only when the action requires it: an
  // action that reads both the buffer and the selection narrows to the
  // selection, which is what somebody highlighting a function then pressing
  // Review expects.
  if (state.selection?.startLine) {
    input.startLine = state.selection.startLine
    input.endLine = state.selection.endLine ?? state.selection.startLine
  }

  if (action.needs === 'seq' || action.sources?.includes('moment')) {
    if (state.seq) input.seq = state.seq
  }

  if (action.needs === 'range' || action.sources?.includes('versions')) {
    if (state.range?.fromSeq) {
      input.fromSeq = state.range.fromSeq
      input.toSeq = state.range.toSeq ?? state.seq
    }
  }

  if (state.executionId && action.sources?.includes('run')) {
    input.executionId = state.executionId
  }

  return input
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 }

/** Findings worst first, and stable within a severity. */
export const bySeverity = (findings) =>
  [...(findings ?? [])].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 1) - (SEVERITY_RANK[b.severity] ?? 1)
  )

export const SEVERITY_LABELS = Object.freeze({
  high: 'High',
  medium: 'Medium',
  low: 'Low',
})

export const SIZE_LABELS = Object.freeze({
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
})

/**
 * The blocks a run actually has something to show for.
 *
 * An action that produces findings and found none should not render an empty
 * "Findings" heading — an empty list is a real answer, and the place to say so
 * is the prose, not a heading with nothing under it.
 */
export function filledBlocks(run) {
  const result = run?.result ?? {}
  const blocks = []

  const push = (name, value) => {
    if (Array.isArray(value) ? value.length : value) blocks.push(name)
  }

  push('findings', result.findings)
  push('steps', result.steps)
  push('tasks', result.tasks)
  push('comparison', result.comparison)
  push('questions', result.questions)
  push('assumptions', result.assumptions)
  push('citations', result.citations)

  return blocks
}

/** Whether a run still has something for somebody to decide. */
export const awaitingReview = (run) =>
  Boolean(
    run?.files?.some((file) => file.status === 'proposed') || run?.patch?.status === 'proposed'
  )

/**
 * A one-line account of what a source contributed, for the chips.
 *
 * The empty case is worded as having looked rather than as having nothing,
 * because "Recent runs — nothing recorded yet" tells a reader the answer is
 * not based on runs, where omitting the chip would leave them assuming it was.
 */
export const describeSource = (source) =>
  source.present ? source.label + ' — ' + source.detail : source.label + ' — nothing to read'

import { CAPABILITIES } from '../../permissions.js'
import { BLOCKS } from './blocks.js'
import { SOURCES } from './sources.js'

/**
 * Every question the copilot can be asked, as data.
 *
 * This file is the point of the whole exercise. Twenty-three buttons, and not
 * one of them has an implementation: an action is a title, the context it
 * belongs to, the room data it reads, the shape of the answer, and the
 * sentences that ask for it. The runner turns that into a model call, the
 * panel turns it into a button, and neither knows what any particular action
 * does.
 *
 * So adding a capability is adding an entry here. No route, no service, no
 * component, no apply path, no new place to forget a permission check — which
 * is the difference between a framework and twenty-three features that happen
 * to be near each other.
 *
 * Three rules for a new entry:
 *
 *  - Declare every source it reads and nothing more. Sources are what the
 *    person is shown as "room data used", so an undeclared read is a lie and
 *    a declared-but-unused one is noise.
 *  - Produce `answer` first, always. It is the block that streams.
 *  - If it can change the room, give it an `apply`. Anything without one is
 *    advice, and the interface will not offer a button that writes.
 */

/** The five things somebody can be doing in a room. */
export const CONTEXTS = Object.freeze([
  {
    id: 'whiteboard',
    label: 'Whiteboard',
    icon: 'pen',
    detail: 'The design on the board',
  },
  {
    id: 'code',
    label: 'Code',
    icon: 'code',
    detail: 'The shared buffer, and what you have selected in it',
  },
  {
    id: 'execution',
    label: 'Runs',
    icon: 'play',
    detail: 'What happened when the code ran',
  },
  {
    id: 'replay',
    label: 'Replay',
    icon: 'clock',
    detail: 'The history, and the point you are paused on',
  },
  {
    id: 'room',
    label: 'Room',
    icon: 'grid',
    detail: 'The session as a whole',
  },
])

export const CONTEXT_IDS = Object.freeze(CONTEXTS.map((context) => context.id))

/**
 * The house style, shared by every action.
 *
 * The second paragraph is the one that earns its place. A model asked to
 * review an architecture it can barely see will review the architecture it
 * assumes you meant, and the result reads exactly like a real review — which
 * is the failure mode worth spending prompt on, because it is the one a reader
 * cannot detect.
 */
const HOUSE_RULES = [
  'You are a staff engineer working alongside the people in a shared room. You are not a chatbot:',
  'no greetings, no "certainly", no restating the question, no offers to help further. Answer, and',
  'stop.',
  '',
  'You are shown extracts of the room — only what is listed below. That material is the whole of',
  'what you know.',
  '',
  '- Never describe code, components, files, people or decisions that are not in the material.',
  '  Saying "the material does not show this" is a correct and useful answer.',
  '- Where something matters and the material is silent, say so rather than filling it in. If the',
  '  action produces "questions" or "assumptions", that is where it goes.',
  '- Cite specifics. A line number, a component name, a run\'s exit code. A review with no',
  '  specifics is worth nothing to the person reading it.',
  '- Be brief. Engineers reading this are mid-task.',
].join('\n')

const define = (action) => Object.freeze({ ...action })

/**
 * `apply` says what an answer may be turned into, and is the only reason the
 * server will ever write anything on a model's say-so:
 *
 *  - `files` — a change set, reviewed file by file, written into the room's
 *    files. Needs the capability for uploading files, not merely for asking.
 *  - `code`  — a replacement for the shared buffer, applied by the client
 *    inside one Yjs transaction and only if the buffer has not moved since.
 *
 * Everything else is advice, which is most of it, and advice cannot overwrite
 * anything by construction rather than by remembering to check.
 */
const APPLY = Object.freeze({
  FILES: { kind: 'files', capability: CAPABILITIES.FILES_UPLOAD },
  CODE: { kind: 'code', capability: CAPABILITIES.CODE_EDIT },
})

export const ACTIONS = Object.freeze([
  /* ---------- whiteboard ---------- */

  define({
    id: 'whiteboard.explain',
    context: 'whiteboard',
    title: 'Explain architecture',
    detail: 'What the diagram says this system is',
    icon: 'layers',
    sources: ['architecture'],
    produces: ['answer', 'findings', 'questions'],
    ask:
      'Explain this architecture to an engineer joining the room: what the system is, what each ' +
      'component does, and how a request moves through it. Put anything the diagram leaves ' +
      'genuinely ambiguous in "questions", and use "findings" only for parts of the diagram that ' +
      'are unclear or contradictory — not for opinions about the design.',
  }),

  define({
    id: 'whiteboard.review',
    context: 'whiteboard',
    title: 'Review architecture',
    detail: 'Where this design will hurt',
    icon: 'search',
    sources: ['architecture'],
    produces: ['answer', 'findings', 'questions'],
    ask:
      'Review this design the way you would review a colleague\'s. In "findings", give each ' +
      'concrete problem: a missing component, a connection that should not exist, a boundary in ' +
      'the wrong place, a single point of failure. Severity is about consequence, not confidence. ' +
      'If the design is sound, say so and return few findings — a padded review is a useless one.',
  }),

  define({
    id: 'whiteboard.generate.code',
    context: 'whiteboard',
    title: 'Generate code',
    detail: 'A first implementation of what is drawn',
    icon: 'zap',
    sources: ['architecture', 'files'],
    produces: ['answer', 'files', 'assumptions', 'questions'],
    apply: APPLY.FILES,
    ask:
      'Write a first implementation of this design. Prefer a small, coherent, runnable skeleton ' +
      'over breadth — working stubs beat forty empty files. Real error handling, no placeholder ' +
      'secrets, no TODO that hides a decision you should have raised as a question. Where the ' +
      'diagram is silent, choose a sensible default and record it in "assumptions".',
  }),

  define({
    id: 'whiteboard.generate.api',
    context: 'whiteboard',
    title: 'Generate API',
    detail: 'The endpoints this design implies',
    icon: 'code',
    sources: ['architecture', 'files'],
    produces: ['answer', 'files', 'assumptions', 'questions'],
    apply: APPLY.FILES,
    ask:
      'Design the HTTP API this architecture implies and write it. Every endpoint needs request ' +
      'validation, the error cases handled, and status codes that mean what they say. Include a ' +
      'written description of the routes as one of the files if it helps a reader.',
  }),

  define({
    id: 'whiteboard.risks',
    context: 'whiteboard',
    title: 'Find risks',
    detail: 'What could fail, and how badly',
    icon: 'alert',
    sources: ['architecture', 'runs'],
    produces: ['answer', 'findings', 'questions'],
    ask:
      'Find the operational risks in this design: what fails, what it takes down with it, what ' +
      'gets slow under load, where data is lost, where a security boundary is missing. One ' +
      'finding per risk, severity by blast radius. Do not list generic good practice that this ' +
      'diagram gives you no reason to raise.',
  }),

  define({
    id: 'whiteboard.plan',
    context: 'whiteboard',
    title: 'Generate implementation plan',
    detail: 'The order a team would build this in',
    icon: 'list',
    sources: ['architecture', 'files', 'timeline'],
    produces: ['answer', 'steps', 'questions'],
    ask:
      'Lay out the order a small team would build this in. Each step should be something ' +
      'finishable that leaves the system working. Say what it unblocks. If the history shows ' +
      'parts of this already exist, start from where the room actually is rather than from zero.',
  }),

  /* ---------- code ---------- */

  define({
    id: 'code.explain',
    context: 'code',
    title: 'Explain selection',
    detail: 'What the highlighted code does',
    icon: 'search',
    sources: ['selection'],
    produces: ['answer', 'questions'],
    needs: 'selection',
    ask:
      'Explain what this code does: its purpose, how it works, and anything surprising about it. ' +
      'Do not restate it line by line — explain the parts that are not obvious from reading it.',
  }),

  define({
    id: 'code.bug',
    context: 'code',
    title: 'Find bug',
    detail: 'What is wrong with this code',
    icon: 'alert',
    sources: ['code', 'selection', 'runs'],
    produces: ['answer', 'findings', 'patch'],
    apply: APPLY.CODE,
    ask:
      'Find the bugs. For each, say in "findings" what input or state triggers it and what goes ' +
      'wrong — a claim with no failing case is a guess. If there is one clear fix, put the whole ' +
      'corrected buffer in "patch"; if the fixes are speculative or would need decisions, leave ' +
      '"patch" out and let the findings stand. Finding nothing is a valid answer.',
  }),

  define({
    id: 'code.tests',
    context: 'code',
    title: 'Generate tests',
    detail: 'Tests for what is here now',
    icon: 'check',
    sources: ['code', 'selection', 'files'],
    produces: ['answer', 'files', 'assumptions'],
    apply: APPLY.FILES,
    ask:
      'Write tests for this code as whole files. Cover the behaviour that matters and the edge ' +
      'cases that would actually break: boundaries, empty input, error paths. Do not write tests ' +
      'that only restate the implementation. Name the framework you are writing for in ' +
      '"assumptions" if the code does not make it obvious.',
  }),

  define({
    id: 'code.optimize',
    context: 'code',
    title: 'Optimize',
    detail: 'Make it faster or simpler, same behaviour',
    icon: 'zap',
    sources: ['code', 'selection', 'runs'],
    produces: ['answer', 'findings', 'patch'],
    apply: APPLY.CODE,
    ask:
      'Improve this code without changing what it does. Say in "answer" what you changed and why ' +
      'it is faster or clearer, and put the complete revised buffer in "patch". If the code is ' +
      'already reasonable, say so and leave "patch" out rather than churning it.',
  }),

  define({
    id: 'code.review',
    context: 'code',
    title: 'Review',
    detail: 'The review a colleague would give',
    icon: 'eye',
    sources: ['code', 'selection'],
    produces: ['answer', 'findings', 'questions'],
    ask:
      'Review this code: correctness first, then clarity, then structure. Every finding cites a ' +
      'line. Severity is about consequence — a crash is high, a name you would have chosen ' +
      'differently is low and probably should not be a finding at all.',
  }),

  define({
    id: 'code.document',
    context: 'code',
    title: 'Generate documentation',
    detail: 'Docs for what this code actually does',
    icon: 'file',
    sources: ['code', 'selection', 'files'],
    produces: ['answer', 'files', 'questions'],
    apply: APPLY.FILES,
    ask:
      'Write documentation for this code as whole files — a README, or reference for the ' +
      'functions it exposes. Document what the code does, not what it should do. Where the ' +
      'intended behaviour is genuinely unclear from the code, ask rather than inventing it.',
  }),

  /* ---------- execution ---------- */

  define({
    id: 'execution.explain',
    context: 'execution',
    title: 'Explain error',
    detail: 'What the output is telling you',
    icon: 'alert',
    sources: ['run', 'code'],
    produces: ['answer', 'findings'],
    ask:
      'Explain what this run\'s output means, in the order a person would work through it: what ' +
      'failed, what the message actually says, and which line of the code it points at. If the ' +
      'run succeeded, say what it printed and leave it there.',
  }),

  define({
    id: 'execution.diagnose',
    context: 'execution',
    title: 'Diagnose failure',
    detail: 'The cause, not the symptom',
    icon: 'search',
    sources: ['run', 'runs', 'code'],
    produces: ['answer', 'findings', 'steps'],
    ask:
      'Work out why this failed. Separate the symptom from the cause. Use "steps" for what to do ' +
      'next in order, most likely cause first. If the recent runs show this failing the same way ' +
      'repeatedly, or failing only sometimes, that is the most important thing you can say.',
  }),

  define({
    id: 'execution.testcase',
    context: 'execution',
    title: 'Generate test case',
    detail: 'A test that reproduces this',
    icon: 'check',
    sources: ['run', 'code', 'files'],
    produces: ['answer', 'files', 'assumptions'],
    apply: APPLY.FILES,
    ask:
      'Write a test that reproduces what this run did — failing now for the same reason, and ' +
      'passing once it is fixed. If the run succeeded, write the test that pins the behaviour it ' +
      'demonstrated so it cannot regress.',
  }),

  define({
    id: 'execution.fix',
    context: 'execution',
    title: 'Suggest fix',
    detail: 'A change that would make this pass',
    icon: 'wrench',
    sources: ['run', 'code'],
    produces: ['answer', 'patch', 'findings', 'questions'],
    apply: APPLY.CODE,
    ask:
      'Propose the change that makes this run succeed. Put the complete corrected buffer in ' +
      '"patch" and explain in "answer" what you changed and why that addresses the cause. If the ' +
      'output does not give you enough to fix it confidently, say what you would need instead of ' +
      'guessing at a patch.',
  }),

  define({
    id: 'execution.compare',
    context: 'execution',
    title: 'Compare runs',
    detail: 'What changed between them',
    icon: 'grid',
    sources: ['runs'],
    produces: ['answer', 'comparison', 'findings'],
    ask:
      'Compare the two most recent runs. One row in "comparison" per thing that differs — exit ' +
      'code, duration, what the output said — and leave out everything identical. Then say in ' +
      '"answer" what the difference suggests changed between them.',
  }),

  /* ---------- replay ---------- */

  define({
    id: 'replay.moment',
    context: 'replay',
    title: 'Explain this moment',
    detail: 'What was happening at this point',
    icon: 'clock',
    sources: ['moment', 'timeline'],
    produces: ['answer', 'steps', 'citations'],
    needs: 'seq',
    grounded: true,
    ask:
      'Explain what was happening at the paused moment: what changed, and what led to it. Use ' +
      '"steps" for the lead-up in order. Cite the ids of the events you are relying on — a ' +
      'statement resting on no event is removed before anyone sees it.',
  }),

  define({
    id: 'replay.changes',
    context: 'replay',
    title: 'Summarize changes',
    detail: 'What this stretch of the session did',
    icon: 'list',
    sources: ['timeline'],
    produces: ['answer', 'steps', 'citations'],
    grounded: true,
    ask:
      'Summarise what the session changed, in order. "steps" is the sequence of what was built, ' +
      'each one citing the events it rests on. Past tense, plain, specific.',
  }),

  define({
    id: 'replay.compare',
    context: 'replay',
    title: 'Compare versions',
    detail: 'Two points in the history, side by side',
    icon: 'grid',
    sources: ['versions', 'timeline'],
    produces: ['answer', 'comparison', 'citations'],
    needs: 'range',
    grounded: true,
    ask:
      'Compare the two points. One row in "comparison" per thing that differs, leaving out what ' +
      'is unchanged. Then say what the work between them was actually doing.',
  }),

  define({
    id: 'replay.decision',
    context: 'replay',
    title: 'Explain decision',
    detail: 'What was chosen here, and over what',
    icon: 'search',
    sources: ['moment', 'timeline'],
    produces: ['answer', 'findings', 'citations'],
    needs: 'seq',
    grounded: true,
    ask:
      'Identify the decision visible at this point: something added and kept, one approach ' +
      'replaced by another, something tried and abandoned. Say what was chosen and what it ' +
      'replaced. The events show what was done, never why — do not supply a motive they do not ' +
      'contain. If no decision is visible here, say so.',
  }),

  /* ---------- room ---------- */

  define({
    id: 'room.summary',
    context: 'room',
    title: 'Summarize session',
    detail: 'What this room has produced',
    icon: 'file',
    sources: ['timeline', 'runs', 'comments'],
    produces: ['answer', 'findings', 'citations'],
    grounded: true,
    ask:
      'Write the record of this session: what was built, what worked, what did not, and what was ' +
      'still open at the end. Use "findings" for anything still standing — a failure with no ' +
      'later success, an unresolved thread — with severity by how much it blocks.',
  }),

  define({
    id: 'room.tasks',
    context: 'room',
    title: 'Generate tasks',
    detail: 'The work this session implies',
    icon: 'list',
    sources: ['timeline', 'architecture', 'comments', 'runs'],
    produces: ['answer', 'tasks', 'questions'],
    ask:
      'Turn what happened in this room into work items. Each is one thing one person can pick up ' +
      'and finish, titled so it can be read on a board without context. Only tasks the material ' +
      'supports — an unresolved comment, a failing run, a component drawn but never built.',
  }),

  define({
    id: 'room.unfinished',
    context: 'room',
    title: 'Find unfinished work',
    detail: 'What was started and left',
    icon: 'alert',
    sources: ['timeline', 'comments', 'runs', 'architecture'],
    produces: ['answer', 'findings', 'tasks'],
    ask:
      'Find what is unfinished: a run that failed and was never made to pass, a comment thread ' +
      'still open, something drawn on the board with no code behind it, work that stopped ' +
      'mid-way. Each finding says what state it was left in. Do not count finished work as ' +
      'unfinished because it could be extended.',
  }),

  define({
    id: 'room.report',
    context: 'room',
    title: 'Generate engineering report',
    detail: 'The written account of this room',
    icon: 'file',
    sources: ['timeline', 'architecture', 'runs', 'comments', 'files'],
    produces: ['answer', 'steps', 'findings', 'tasks', 'citations'],
    grounded: true,
    ask:
      'Write an engineering report a lead could read without having been here: what the room set ' +
      'out to build, what exists now, how it was arrived at ("steps"), what is wrong or risky ' +
      '("findings") and what remains ("tasks"). Ground every claim in the material — this is a ' +
      'report, not a retrospective narrative.',
  }),
])

const BY_ID = new Map(ACTIONS.map((action) => [action.id, action]))

export const actionById = (id) => BY_ID.get(String(id)) ?? null

/** What the client renders as buttons. Never the prompts — those are ours. */
export const describeActions = () =>
  ACTIONS.map(({ id, context, title, detail, icon, sources, produces, apply, needs }) => ({
    id,
    context,
    title,
    detail,
    icon,
    sources,
    produces,
    needs: needs ?? null,
    apply: apply?.kind ?? null,
  }))

/**
 * The system prompt for one action: the house rules, then what it is for.
 *
 * Built rather than stored so the rules cannot drift between twenty-three
 * copies of them — the failure mode being that the one action whose prompt
 * nobody updated is the one that invents a component.
 */
export const systemFor = (action) =>
  [HOUSE_RULES, '', 'THIS REQUEST', action.ask].join('\n')

/**
 * Guards the registry at import time.
 *
 * A typo in a source or block name would otherwise surface as a failed request
 * on whichever button nobody pressed during review — and the point of a
 * registry is that the registry is checkable.
 */
for (const action of ACTIONS) {
  if (!CONTEXT_IDS.includes(action.context)) {
    throw new Error(action.id + ': unknown context ' + action.context)
  }
  if (action.produces[0] !== 'answer') {
    throw new Error(action.id + ': must produce "answer" first — it is the block that streams')
  }
  for (const source of action.sources) {
    if (!SOURCES[source]) throw new Error(action.id + ': unknown source ' + source)
  }
  for (const block of action.produces) {
    if (!BLOCKS[block]) throw new Error(action.id + ': unknown block ' + block)
  }
  if (action.grounded && !action.produces.includes('citations')) {
    throw new Error(action.id + ': grounded actions must produce citations')
  }
  if (action.apply?.kind === 'files' && !action.produces.includes('files')) {
    throw new Error(action.id + ': offers to write files but produces none')
  }
  if (action.apply?.kind === 'code' && !action.produces.includes('patch')) {
    throw new Error(action.id + ': offers to change the buffer but produces no patch')
  }
  // A patch is only allowed to be applied against the text it was written
  // from, so an action proposing one has to have read the whole buffer. A
  // selection alone would give the model a fragment and the reviewer a
  // replacement for everything.
  if (action.apply?.kind === 'code' && !action.sources.includes('code')) {
    throw new Error(action.id + ': proposes a buffer patch without reading the buffer')
  }
}

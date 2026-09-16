import { describe, expect, it } from 'vitest'
import { activityDetail, activityIcon, collapseActivity, describeActivity } from './activity.js'

/**
 * How an event is said.
 *
 * The server records what happened and this decides the wording, which is why
 * these are worth pinning separately: the two things that break a feed are a
 * kind the client has not heard of, and an actor with no name. Neither is
 * hypothetical - the first is what a deploy looks like mid-rollout, and the
 * second is every guest who ever joined by link.
 */
describe('describing what happened', () => {
  it('names the person and what they did', () => {
    expect(describeActivity({ kind: 'code.edited', actorName: 'Jishu' })).toBe(
      'Jishu edited the code'
    )
    expect(describeActivity({ kind: 'whiteboard.updated', actorName: 'Ayush' })).toBe(
      'Ayush updated the whiteboard'
    )
  })

  it('says Somebody rather than null for a guest who never gave a name', () => {
    expect(describeActivity({ kind: 'collaborator.joined', actorName: null })).toBe(
      'Somebody joined the room'
    )
    expect(describeActivity({ kind: 'collaborator.joined', actorName: '   ' })).toBe(
      'Somebody joined the room'
    )
  })

  /**
   * A server one version ahead can send a kind this client has never heard of.
   * The line has to stay readable rather than disappear or throw.
   */
  it('renders a kind it does not know instead of breaking the feed', () => {
    expect(describeActivity({ kind: 'room.exploded', actorName: 'Owner' })).toBe(
      'Owner did something'
    )
    expect(activityIcon({ kind: 'room.exploded' })).toBe('activity')
    expect(describeActivity(undefined)).toBe('Somebody did something')
  })

  it('gives each kind its own icon', () => {
    expect(activityIcon({ kind: 'execution.completed' })).toBe('play')
    expect(activityIcon({ kind: 'code.edited' })).toBe('code')
  })

  it('treats an empty detail as no detail', () => {
    expect(activityDetail({ detail: 'python ran cleanly' })).toBe('python ran cleanly')
    expect(activityDetail({ detail: '  ' })).toBeNull()
    expect(activityDetail({})).toBeNull()
  })
})

/**
 * Pressing Run four times is one thing that happened, not four. As four rows it
 * pushed the rest of the feed off the bottom of the dashboard.
 */
describe('folding repeats', () => {
  const ran = (over = {}) => ({
    id: 'e' + Math.random(),
    kind: 'execution.completed',
    roomId: 'room-1',
    actorName: 'XYZ',
    detail: 'java ran cleanly',
    at: '2026-09-15T10:00:00.000Z',
    ...over,
  })

  it('folds a run of identical events into one row that counts them', () => {
    const rows = collapseActivity([ran(), ran(), ran(), ran()])

    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(4)
  })

  it('keeps the newest time, which is the one the feed leads with', () => {
    const rows = collapseActivity([
      ran({ at: '2026-09-15T12:00:00.000Z' }),
      ran({ at: '2026-09-15T09:00:00.000Z' }),
    ])

    expect(rows[0].at).toBe('2026-09-15T12:00:00.000Z')
  })

  it('keeps apart what only looks the same', () => {
    const rows = collapseActivity([
      ran(),
      ran({ actorName: 'Jishu' }),
      ran({ roomId: 'room-2' }),
      ran({ detail: 'python ran cleanly' }),
      ran({ kind: 'code.edited', detail: null }),
    ])

    expect(rows.map((row) => row.count)).toEqual([1, 1, 1, 1, 1])
  })

  /** Only consecutive rows fold, so the feed still reads as a history. */
  it('does not reach past something that happened in between', () => {
    const rows = collapseActivity([ran(), ran({ actorName: 'Jishu' }), ran()])

    expect(rows.map((row) => row.actorName + ':' + row.count)).toEqual(['XYZ:1', 'Jishu:1', 'XYZ:1'])
  })

  it('leaves the original events alone', () => {
    const events = [ran(), ran()]
    collapseActivity(events)

    expect(events[0].count).toBeUndefined()
  })

  it('survives being handed nothing', () => {
    expect(collapseActivity()).toEqual([])
    expect(collapseActivity([])).toEqual([])
  })
})

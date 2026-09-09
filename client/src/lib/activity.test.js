import { describe, expect, it } from 'vitest'
import { activityDetail, activityIcon, describeActivity } from './activity.js'

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

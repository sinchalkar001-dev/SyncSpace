import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CAP, useRoomAccess } from './useRoomAccess.js'

/**
 * What the interface is allowed to offer.
 *
 * None of this is a security boundary — every capability is checked again on
 * the server, at the route, on the socket and on the Yjs connection. What it
 * decides is whether a person is shown a button that would fail, which is the
 * difference between a rule and a bug as far as they can tell.
 *
 * The important case is the first one: before the server has answered, the
 * answer is no. Assuming yes and hiding later flashes controls a viewer cannot
 * use, and anybody quick enough to click in that window gets a refusal that
 * looks like something broke.
 */
describe('useRoomAccess', () => {
  it('allows nothing until the server has answered', () => {
    const { result } = renderHook(() => useRoomAccess())

    expect(result.current.loaded).toBe(false)
    expect(result.current.role).toBeNull()
    expect(result.current.can(CAP.CODE_EDIT)).toBe(false)
    expect(result.current.can(CAP.ROOM_VIEW)).toBe(false)
  })

  it('takes the capability list from the server rather than deriving it', () => {
    const { result } = renderHook(() => useRoomAccess())

    act(() =>
      result.current.receive({
        role: 'runner',
        capabilities: [CAP.ROOM_VIEW, CAP.CHAT_SEND, CAP.CODE_EXECUTE],
        assignable: [],
        isGuest: false,
      })
    )

    expect(result.current.role).toBe('runner')
    expect(result.current.can(CAP.CODE_EXECUTE)).toBe(true)
    // Not derived from the role name: the server said so, and it did not.
    expect(result.current.can(CAP.CODE_EDIT)).toBe(false)
    expect(result.current.loaded).toBe(true)
  })

  it('reports what this person may hand out, for the role menu', () => {
    const { result } = renderHook(() => useRoomAccess())

    act(() =>
      result.current.receive({
        role: 'admin',
        capabilities: [CAP.ROLES_MANAGE],
        assignable: ['editor', 'runner', 'commenter', 'viewer'],
        isGuest: false,
      })
    )

    expect(result.current.assignable).toEqual(['editor', 'runner', 'commenter', 'viewer'])
    // An admin cannot appoint an admin, and the menu must not offer it.
    expect(result.current.assignable).not.toContain('admin')
  })

  it('treats a room it was refused as allowing nothing', () => {
    const { result } = renderHook(() => useRoomAccess())

    act(() => result.current.receive({ role: null, capabilities: [], assignable: [], isGuest: false }))

    expect(result.current.can(CAP.ROOM_VIEW)).toBe(false)
    expect(result.current.loaded).toBe(true)
  })

  it('copes with a server that sends nothing at all', () => {
    const { result } = renderHook(() => useRoomAccess())

    act(() => result.current.receive(undefined))

    expect(result.current.role).toBeNull()
    expect(result.current.can(CAP.CODE_EDIT)).toBe(false)
  })

  it('marks a guest, so the interface can explain rather than refuse', () => {
    const { result } = renderHook(() => useRoomAccess())

    act(() =>
      result.current.receive({
        role: 'editor',
        capabilities: [CAP.CODE_EDIT, CAP.CODE_EXECUTE],
        assignable: [],
        isGuest: true,
      })
    )

    expect(result.current.isGuest).toBe(true)
    expect(result.current.can(CAP.CODE_EDIT)).toBe(true)
    // Withheld by the server for anybody without an account.
    expect(result.current.can(CAP.FILES_UPLOAD)).toBe(false)
  })
})

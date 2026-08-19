let instance = null

/**
 * Deleting a room has to hang up anyone still connected to it, but the room
 * service must not import the server (that would be circular). The running
 * Hocuspocus instance is registered here instead.
 */
export function setHocuspocus(next) {
  instance = next
}

export function getHocuspocus() {
  return instance
}

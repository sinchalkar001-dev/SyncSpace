let instance = null

/**
 * The running Socket.io server, for code outside the socket layer that needs
 * to tell a room something.
 *
 * The run endpoint is HTTP — it wants validation, rate limiting and a plain
 * response — but its result belongs to everyone in the room, not only the
 * person who pressed the button. Importing the server from a route would be
 * circular, so it registers itself here at startup, exactly as Hocuspocus
 * does in collab/registry.js.
 */
export function setIo(next) {
  instance = next
}

export function getIo() {
  return instance
}

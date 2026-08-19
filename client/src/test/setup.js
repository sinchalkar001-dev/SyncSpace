import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

/**
 * The jsdom build in this environment exposes a `localStorage` global that is
 * missing the Storage API (no getItem/setItem/clear), so anything touching it
 * throws. Install a conforming in-memory implementation instead of depending
 * on the host.
 */
class MemoryStorage {
  #data = new Map()

  get length() {
    return this.#data.size
  }

  key(index) {
    return [...this.#data.keys()][index] ?? null
  }

  getItem(key) {
    const stored = this.#data.get(String(key))
    return stored === undefined ? null : stored
  }

  setItem(key, value) {
    this.#data.set(String(key), String(value))
  }

  removeItem(key) {
    this.#data.delete(String(key))
  }

  clear() {
    this.#data.clear()
  }
}

const storage = new MemoryStorage()
const definition = { value: storage, configurable: true, writable: true }

Object.defineProperty(globalThis, 'localStorage', definition)
if (typeof window !== 'undefined') Object.defineProperty(window, 'localStorage', definition)

afterEach(() => {
  cleanup()
  storage.clear()
})

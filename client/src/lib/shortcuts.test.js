import { afterEach, describe, expect, it } from 'vitest'
import { typedElsewhere } from './shortcuts.js'

/**
 * Ctrl+Enter runs the code — from the editor. Typed into the comment box, it
 * sends the comment, and must not also run the program.
 */

function room() {
  document.body.innerHTML = `
    <section id="editor">
      <textarea id="monaco-input"></textarea>
      <textarea id="stdin"></textarea>
      <button id="run">Run</button>
    </section>
    <div id="panel"><textarea id="comment"></textarea><input id="search" /></div>
    <div id="board" tabindex="0"></div>`
  return {
    editor: document.getElementById('editor'),
    get: (id) => document.getElementById(id),
  }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('typedElsewhere', () => {
  it('leaves a key typed into some other field to that field', () => {
    const { editor, get } = room()
    expect(typedElsewhere(get('comment'), editor)).toBe(true)
    expect(typedElsewhere(get('search'), editor)).toBe(true)
  })

  it('keeps a key typed inside the surface, its own fields included', () => {
    const { editor, get } = room()
    expect(typedElsewhere(get('monaco-input'), editor)).toBe(false)
    expect(typedElsewhere(get('stdin'), editor)).toBe(false)
    expect(typedElsewhere(get('run'), editor)).toBe(false)
  })

  it('keeps a key pressed anywhere that is not a text field', () => {
    const { editor, get } = room()
    expect(typedElsewhere(get('board'), editor)).toBe(false)
    expect(typedElsewhere(document.body, editor)).toBe(false)
    expect(typedElsewhere(null, editor)).toBe(false)
  })
})

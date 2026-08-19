import { useEffect, useMemo, useRef } from 'react'
import Editor from '@monaco-editor/react'
import { MonacoBinding } from 'y-monaco'
import { LANGUAGES } from '../../lib/monacoSetup.js'
import { useUIStore } from '../../store/uiStore.js'

const EDITOR_OPTIONS = {
  fontSize: 13.5,
  fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
  minimap: { enabled: false },
  smoothScrolling: true,
  cursorBlinking: 'smooth',
  renderLineHighlight: 'line',
  scrollBeyondLastLine: false,
  automaticLayout: true,
  padding: { top: 14 },
  tabSize: 2,
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
}

function hexToRgba(hex, alpha) {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.replace(/./g, (c) => c + c) : value
  const int = parseInt(full, 16)
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')'
}

/**
 * y-monaco tags each remote caret with `yRemoteSelection-<clientId>` classes
 * but ships no colours, so the per-peer rules are generated here.
 */
function remoteSelectionCss(peers) {
  return peers
    .filter((peer) => peer.user)
    .map((peer) => {
      const color = peer.user.color || '#22d3ee'
      const head = '.yRemoteSelectionHead-' + peer.clientId
      const selection = '.yRemoteSelection-' + peer.clientId
      const label = JSON.stringify(peer.user.name || 'Guest')

      return [
        selection + ' { background-color: ' + hexToRgba(color, 0.32) + '; }',
        head + ' { position: absolute; box-sizing: border-box; height: 100%;',
        '  border-left: 2px solid ' + color + '; }',
        head + '::after { content: ' + label + '; position: absolute; top: -1.35em; left: -2px;',
        '  padding: 0 4px; font-size: 10px; line-height: 1.35em; white-space: nowrap;',
        '  border-radius: 3px 3px 3px 0; color: #0d1211; background-color: ' + color + ';',
        '  pointer-events: none; }',
      ].join('\n')
    })
    .join('\n')
}

export function CodeEditor({ yText, provider, peers }) {
  const bindingRef = useRef(null)
  const language = useUIStore((s) => s.language)
  const setLanguage = useUIStore((s) => s.setLanguage)

  const handleMount = (editor, monaco) => {
    monaco.editor.setTheme('syncspace-dark')
    const model = editor.getModel()
    if (!model || !yText || !provider) return

    // Binding the Yjs text type to the Monaco model is what makes concurrent
    // edits merge; the model itself is never the source of truth.
    bindingRef.current = new MonacoBinding(yText, model, new Set([editor]), provider.awareness)
  }

  useEffect(
    () => () => {
      bindingRef.current?.destroy()
      bindingRef.current = null
    },
    []
  )

  const css = useMemo(() => remoteSelectionCss(peers), [peers])

  return (
    <section className="pane pane--editor">
      <header className="pane__bar">
        <span className="pane__title">Code</span>
        <label className="pane__control">
          <span className="sr-only">Editor language</span>
          <select value={language} onChange={(event) => setLanguage(event.target.value)}>
            {LANGUAGES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </header>

      <style>{css}</style>

      <div className="editor-host">
        <Editor
          language={language}
          theme="syncspace-dark"
          options={EDITOR_OPTIONS}
          onMount={handleMount}
          loading={<div className="editor-loading">Loading editor…</div>}
        />
      </div>
    </section>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { MonacoBinding } from 'y-monaco'
import { useUIStore } from '../../store/uiStore.js'
import { Icon } from '../ui/Icon.jsx'
import { LanguagePicker } from './LanguagePicker.jsx'
import { EditorStatusBar } from './EditorStatusBar.jsx'

const TAB_SIZE = 2

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

export function CodeEditor({ yText, provider, peers, status = 'connecting', synced = false }) {
  const bindingRef = useRef(null)
  const editorRef = useRef(null)

  const language = useUIStore((s) => s.language)
  const editorPrefs = useUIStore((s) => s.editor)
  const toggleEditorOption = useUIStore((s) => s.toggleEditorOption)
  const paneMode = useUIStore((s) => s.paneMode)
  const setPaneMode = useUIStore((s) => s.setPaneMode)

  const [position, setPosition] = useState({ line: 1, column: 1, selected: 0 })
  const [empty, setEmpty] = useState(true)

  const options = useMemo(
    () => ({
      fontSize: editorPrefs.fontSize,
      fontFamily: "'IBM Plex Mono', 'JetBrains Mono', Consolas, monospace",
      minimap: { enabled: editorPrefs.minimap },
      wordWrap: editorPrefs.wordWrap ? 'on' : 'off',
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      renderLineHighlight: 'line',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      padding: { top: 14, bottom: 14 },
      tabSize: TAB_SIZE,
      bracketPairColorization: { enabled: true },
      guides: { bracketPairs: true, indentation: true },
      folding: true,
      matchBrackets: 'always',
      renderWhitespace: 'selection',
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
    }),
    [editorPrefs]
  )

  const handleMount = useCallback(
    (editor, monaco) => {
      monaco.editor.setTheme('syncspace-dark')
      editorRef.current = editor

      const model = editor.getModel()
      if (!model || !yText || !provider) return

      // Binding the Yjs text type to the Monaco model is what makes concurrent
      // edits merge; the model itself is never the source of truth.
      bindingRef.current = new MonacoBinding(yText, model, new Set([editor]), provider.awareness)

      const readPosition = () => {
        const at = editor.getPosition()
        const selection = editor.getSelection()
        const selected = selection ? model.getValueInRange(selection).length : 0
        if (at) setPosition({ line: at.lineNumber, column: at.column, selected })
      }

      readPosition()
      setEmpty(model.getValue().trim() === '')

      editor.onDidChangeCursorPosition(readPosition)
      editor.onDidChangeCursorSelection(readPosition)
      model.onDidChangeContent(() => setEmpty(model.getValue().trim() === ''))
    },
    [yText, provider]
  )

  useEffect(
    () => () => {
      bindingRef.current?.destroy()
      bindingRef.current = null
    },
    []
  )

  const format = useCallback(() => {
    editorRef.current?.getAction('editor.action.formatDocument')?.run()
  }, [])

  const find = useCallback(() => {
    editorRef.current?.getAction('actions.find')?.run()
  }, [])

  const css = useMemo(() => remoteSelectionCss(peers), [peers])
  const expanded = paneMode === 'code'

  return (
    <section className="pane pane--editor" aria-label="Code editor">
      <header className="pane__bar">
        <span className="pane__title">Code</span>
        <LanguagePicker />

        <span className="pane__spacer" />

        <button type="button" className="panebtn" onClick={find} title="Find (Ctrl+F)" aria-label="Find">
          <Icon name="search" size={14} />
        </button>
        <button
          type="button"
          className="panebtn"
          onClick={format}
          title="Format document"
          aria-label="Format document"
        >
          <Icon name="zap" size={14} />
        </button>
        <button
          type="button"
          className={'panebtn' + (editorPrefs.wordWrap ? ' is-active' : '')}
          onClick={() => toggleEditorOption('wordWrap')}
          aria-pressed={editorPrefs.wordWrap}
          title="Word wrap"
          aria-label="Word wrap"
        >
          <Icon name="text" size={14} />
        </button>
        <button
          type="button"
          className={'panebtn' + (editorPrefs.minimap ? ' is-active' : '')}
          onClick={() => toggleEditorOption('minimap')}
          aria-pressed={editorPrefs.minimap}
          title="Minimap"
          aria-label="Minimap"
        >
          <Icon name="layers" size={14} />
        </button>
        <button
          type="button"
          className={'panebtn' + (expanded ? ' is-active' : '')}
          onClick={() => setPaneMode(expanded ? 'split' : 'code')}
          aria-pressed={expanded}
          title={expanded ? 'Back to split view' : 'Expand the editor'}
          aria-label={expanded ? 'Back to split view' : 'Expand the editor'}
        >
          <Icon name="grid" size={14} />
        </button>
      </header>

      <style>{css}</style>

      <div className="editor-host">
        <Editor
          language={language}
          theme="syncspace-dark"
          options={options}
          onMount={handleMount}
          loading={<div className="editor-loading">Loading editor…</div>}
        />

        {empty && (
          <div className="editor-hint" aria-hidden="true">
            <p className="editor-hint__title">Start typing</p>
            <p className="editor-hint__body">
              Everyone in this room edits the same buffer. Press{' '}
              <kbd>Ctrl</kbd>+<kbd>K</kbd> for commands.
            </p>
          </div>
        )}
      </div>

      <EditorStatusBar
        position={position}
        language={language}
        tabSize={TAB_SIZE}
        status={status}
        synced={synced}
        peerCount={peers.length}
      />
    </section>
  )
}

import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// By default @monaco-editor/react pulls Monaco from a CDN at runtime. Point it
// at the bundled copy instead so the editor works offline and behind a CSP.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  },
}

monaco.editor.defineTheme('syncspace-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#151b19',
    'editor.lineHighlightBackground': '#1d2523',
    'editorLineNumber.foreground': '#4a5954',
    'editorLineNumber.activeForeground': '#97a69f',
    'editorGutter.background': '#151b19',
    'editorIndentGuide.background1': '#252f2c',
  },
})

loader.config({ monaco })

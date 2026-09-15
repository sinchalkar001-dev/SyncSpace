/**
 * Monaco, with only what the room's editor uses.
 *
 * `import 'monaco-editor'` is the whole distribution: all of its ~80 syntax
 * grammars plus the CSS, HTML and JSON language services, 3.3 MB before
 * compression. The editor offers seven languages (see languages.js), so this
 * loads the editor core with its standard features — find, folding, hovers,
 * the context menu — and those seven grammars. JavaScript and TypeScript keep
 * their language service, which completions and "Format document" run on.
 *
 * A language added to LANGUAGES needs its contribution imported here as well,
 * or the editor shows it as plain text.
 */
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js'
import 'monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/java/java.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/go/go.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js'
import 'monaco-editor/esm/vs/language/typescript/monaco.contribution.js'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// By default @monaco-editor/react pulls Monaco from a CDN at runtime. Point it
// at the bundled copy instead so the editor works offline and behind a CSP.
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
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

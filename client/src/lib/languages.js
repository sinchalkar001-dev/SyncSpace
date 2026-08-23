/**
 * The languages the editor offers.
 *
 * Deliberately its own module rather than part of monacoSetup: that one
 * imports Monaco itself and installs web workers, which a test environment
 * cannot load. This is a list of names — anything that only needs the names
 * should not have to bring an editor with it.
 */
export const LANGUAGES = [
  'javascript',
  'typescript',
  'python',
  'java',
  'cpp',
  'go',
  'rust',
  'sql',
  'json',
  'html',
  'css',
  'markdown',
]

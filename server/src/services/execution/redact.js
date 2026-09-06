import os from 'node:os'

/**
 * Removes traces of the host from anything a program printed.
 *
 * A stack trace is written by the runtime, not by the person who pressed Run,
 * and it names the file it was running by its real path. On this machine that
 * reads
 *
 *     C:\Users\jishu\AppData\Local\Temp\syncspace-run-eRwD1I\main.js:1
 *
 * which tells everyone in the room the operating system, the account the
 * server runs as, and where its temporary files live. In a public room that is
 * a stranger. Compilers do the same thing, and so does anything that prints
 * `os.hostname()`.
 *
 * The rewrite is deliberately shallow. It is a disclosure control, not a
 * confidentiality boundary: a program can always encode a path it read itself.
 * The boundary is the sandbox — this is what stops the *runner* volunteering
 * host details in the ordinary course of reporting an error.
 */

const SEP = String.fromCharCode(92)

const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Both separators for every path.
 *
 * Node reports `C:\Users\...` on Windows while a tool it invoked may report
 * `C:/Users/...` for the same directory, and a rule that knows only one shape
 * leaves the other in place — which is worse than not trying, because the
 * output then looks redacted.
 */
function pathVariants(value) {
  return [...new Set([value, value.split(SEP).join('/'), value.split('/').join(SEP)])]
}

/** Longest first, so a temp directory is not half-replaced by its parent. */
const bySpecificity = (rules) =>
  rules.filter((rule) => rule.find && rule.find.length > 2).sort((a, b) => b.find.length - a.find.length)

/**
 * Builds the rewriter for one execution.
 *
 * `workDir` is the throwaway directory the program ran in. It becomes nothing
 * at all rather than a placeholder: `main.js:1` is exactly what someone
 * looking at their own file expects to read, and an invented `/sandbox/main.js`
 * would only raise a question with no useful answer.
 */
export function createRedactor({ workDir } = {}) {
  const rules = []

  for (const variant of workDir ? pathVariants(workDir) : []) {
    // The trailing separator goes with it, so `<dir>/main.js` becomes
    // `main.js` rather than `/main.js`, which would read as the filesystem
    // root of a machine the reader cannot see.
    rules.push({ find: variant + SEP, replace: '' })
    rules.push({ find: variant + '/', replace: '' })
    rules.push({ find: variant, replace: '.' })
  }

  // Anything the working directory did not account for: a tool that resolved
  // symlinks, a program that printed a path of its own, an error from a
  // toolchain naming its own install location.
  for (const variant of pathVariants(os.tmpdir())) rules.push({ find: variant, replace: '/tmp' })
  for (const variant of pathVariants(os.homedir())) rules.push({ find: variant, replace: '~' })

  const hostname = os.hostname()
  if (hostname) rules.push({ find: hostname, replace: 'host' })

  const account = process.env.USERNAME || process.env.USER || process.env.LOGNAME
  if (account) rules.push({ find: account, replace: 'user' })

  const ordered = bySpecificity(rules)

  return function redact(text) {
    if (!text) return text

    let out = text
    for (const rule of ordered) {
      out = out.split(rule.find).join(rule.replace)
      // Case-insensitively too: Windows reports the same directory as
      // `C:\Users\...` and `c:\users\...` depending on which tool printed it.
      out = out.replace(new RegExp(escape(rule.find), 'gi'), rule.replace)
    }
    return out
  }
}

/** The no-op form, for call sites with no directory to hide. */
export const identity = (text) => text

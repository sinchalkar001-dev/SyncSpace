#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'

/**
 * Refuses to let a credential reach the repository.
 *
 * This exists because the gitignore was not enough. `server/uploads/` was
 * never listed, so a run of the end-to-end suite quietly staged the files it
 * had written into a room; and a key that lives in `.env` today is one
 * mistyped path or one `git add -f` away from being public tomorrow. A
 * gitignore lists the mistakes somebody already thought of. This looks at
 * what is actually about to be committed.
 *
 *   node scripts/scan-secrets.js            # what is staged (the hook)
 *   node scripts/scan-secrets.js --all      # every tracked file (CI)
 *   node scripts/scan-secrets.js a.js b.js  # named files
 *
 * Exits non-zero, naming the file, the line and what it looks like. A repo
 * that fails this is not one to "fix later": a pushed secret is public the
 * moment it lands, and rewriting history does not un-publish it.
 */

/**
 * Formats whose shape is unambiguous. These are matched everywhere, including
 * in documentation and tests, because a real key in a comment is still a real
 * key and there is no legitimate reason to write a whole one down.
 *
 * The lengths are the vendors' own. Being specific is what keeps this from
 * crying wolf on ordinary base64 — a scanner nobody believes gets switched
 * off, and then it is not a scanner.
 */
const SIGNATURES = [
  { name: 'Google API key', test: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  /**
   * The format AI Studio issues now. Shorter and differently shaped, so the
   * `AIza` rule above does not see it — a scanner that only knows last year's
   * format is exactly the kind that lets the current one through.
   */
  { name: 'Google API key', test: /\bAQ\.[A-Za-z0-9_-]{30,}/ },
  { name: 'Anthropic API key', test: /\bsk-ant-[0-9A-Za-z_-]{24,}/ },
  { name: 'OpenAI API key', test: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'AWS access key id', test: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', test: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'Slack token', test: /\bxox[abprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'Google OAuth client secret', test: /\bGOCSPX-[0-9A-Za-z_-]{20,}/ },
  { name: 'private key block', test: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: 'JSON Web Token', test: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
]

/**
 * A value assigned to a credential-shaped name.
 *
 * Applied only to environment files. Anywhere else this would fire on every
 * `const apiKey = someVariable` in the codebase, and a rule that has to be
 * suppressed constantly teaches people to suppress it.
 */
const ENV_ASSIGNMENT = /^\s*(?:export\s+)?([A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|CREDENTIAL)[A-Z0-9_]*)\s*=\s*(.+)$/

/** Anything that is plainly a stand-in rather than a credential. */
const PLACEHOLDER =
  /^(?:|["']?(?:x{3,}|\.{3}|<[^>]*>|\$\{[^}]*\}|change[- _]?me|your[- _].*|placeholder|example.*|dummy|redacted|todo|none|null|undefined|true|false|abcd efgh ijkl mnop)["']?)$/i

/** An env file that is meant to be committed, versus one that never is. */
const isExampleEnv = (path) => /\.env\.(example|sample|template)$/.test(path)
const isEnvFile = (path) => /(^|\/)\.env(\.|$)/.test(path)

/**
 * Files that describe the patterns rather than containing a secret.
 *
 * Only this scanner and its tests. Kept to an explicit list rather than a
 * pattern, so that widening it is a visible decision in a diff.
 */
const SELF = new Set(['scripts/scan-secrets.js', 'scripts/scan-secrets.test.js'])

/**
 * A note in the file saying the match is deliberate.
 *
 * Honoured on the offending line and on the one above it, because a reason
 * worth writing rarely fits on the end of the line it excuses — and a marker
 * that only works as a trailing comment pushes people into writing no reason
 * at all.
 */
const ALLOW = /secret-scan:\s*allow/i
const allowed = (lines, index) => ALLOW.test(lines[index]) || (index > 0 && ALLOW.test(lines[index - 1]))

const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|mp4|mov|webm|woff2?|ttf|eot|node|wasm)$/i

/** Every finding in one file's contents. */
export function scanText(path, contents) {
  const findings = []
  const lines = contents.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (allowed(lines, index)) return

    for (const signature of SIGNATURES) {
      if (signature.test.test(line)) {
        findings.push({ path, line: index + 1, what: signature.name })
        return
      }
    }

    // A real .env is refused wholesale by `scanPaths`; this is for one that
    // arrives under a name this scanner was not expecting.
    if (!isEnvFile(path) || isExampleEnv(path)) {
      const assignment = ENV_ASSIGNMENT.exec(line)
      if (!assignment) return

      const value = assignment[2].trim().replace(/\s*#.*$/, '').trim()
      const bare = value.replace(/^['"]|['"]$/g, '')

      if (PLACEHOLDER.test(bare)) return
      // Short values are ports, booleans and names, not credentials.
      if (bare.length < 12) return

      findings.push({
        path,
        line: index + 1,
        what: assignment[1] + ' looks like a real value',
      })
    }
  })

  return findings
}

const run = (args) => execFileSync('git', args, { encoding: 'utf8' })

function stagedPaths() {
  return run(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function trackedPaths() {
  return run(['ls-files'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Staged content, which is what is actually about to be committed. */
const stagedContents = (path) => {
  try {
    return run(['show', ':' + path])
  } catch {
    return null
  }
}

export function scanPaths(paths, { staged }) {
  const findings = []

  for (const path of paths) {
    if (SELF.has(path) || BINARY.test(path)) continue

    /**
     * A real environment file is refused on its name alone. Reading it to
     * decide would mean a `.env` full of unrecognised formats sails through,
     * and there is no version of committing one that is correct.
     */
    if (isEnvFile(path) && !isExampleEnv(path)) {
      findings.push({ path, line: 0, what: 'an environment file, which is never committed' })
      continue
    }

    let contents
    if (staged) {
      contents = stagedContents(path)
    } else {
      try {
        if (statSync(path).size > 2_000_000) continue
        contents = readFileSync(path, 'utf8')
      } catch {
        contents = null
      }
    }

    if (contents == null) continue
    findings.push(...scanText(path, contents))
  }

  return findings
}

function main() {
  const args = process.argv.slice(2)
  const all = args.includes('--all')
  const named = args.filter((arg) => !arg.startsWith('--'))

  const staged = !all && named.length === 0
  const paths = named.length > 0 ? named : all ? trackedPaths() : stagedPaths()

  const findings = scanPaths(paths, { staged })

  if (findings.length === 0) {
    process.stdout.write(
      'secret scan: nothing found in ' + paths.length + ' file(s)\n'
    )
    return
  }

  process.stderr.write('\nRefusing to continue — this looks like a credential:\n\n')
  for (const finding of findings) {
    const where = finding.line > 0 ? ':' + finding.line : ''
    process.stderr.write('  ' + finding.path + where + '  — ' + finding.what + '\n')
  }
  process.stderr.write(
    '\nIf a real key has already been written somewhere, rotate it: a secret that\n' +
      'reached a public repository is public from that moment, and deleting the\n' +
      'commit does not take it back.\n\n' +
      'If this is a false positive, put "secret-scan: allow" in a comment on that\n' +
      'line — deliberately, and where a reviewer will see it.\n\n'
  )
  process.exitCode = 1
}

// Only when run, not when imported by the tests.
if (process.argv[1] && process.argv[1].endsWith('scan-secrets.js')) main()

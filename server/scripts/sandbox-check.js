#!/usr/bin/env node
import { RECIPES, RUNNABLE_LANGUAGES } from '../src/services/execution/recipes.js'
import { activeBackendName, resetBackendCache } from '../src/services/execution/backend.js'
import * as docker from '../src/services/execution/backends/docker.backend.js'
import { CONTROL_LABELS, CONTROLS, describeIsolation } from '../src/services/execution/limits.js'
import { listRunnable } from '../src/services/runner.service.js'

/**
 * What this machine will actually do with somebody else's program.
 *
 * Run it at deploy, before anybody can reach the server. The two questions it
 * answers are the ones nobody thinks to ask until afterwards: which backend is
 * really in force — `auto` on a host with a stopped daemon is silently the
 * unsandboxed one — and whether the images are present, since the first run of
 * a language otherwise sits behind a download with no explanation.
 *
 *   node scripts/sandbox-check.js           report
 *   node scripts/sandbox-check.js --pull    fetch anything missing first
 *   node scripts/sandbox-check.js --strict  exit non-zero if anything is unenforced
 */

const args = new Set(process.argv.slice(2))
const wantsPull = args.has('--pull')
const strict = args.has('--strict')

const tick = (ok) => (ok ? 'yes' : 'no')

async function main() {
  resetBackendCache()

  const backend = await activeBackendName()

  if (!backend) {
    console.error('No execution backend available.')
    console.error('SANDBOX_BACKEND=docker was asked for and no container runtime answered,')
    console.error('so this server will refuse to run code rather than run it unsandboxed.')
    process.exitCode = 1
    return
  }

  if (wantsPull && backend === 'docker') {
    console.log('Pulling images (this takes a while the first time)\n')
    const pulled = await docker.pullImages(
      RUNNABLE_LANGUAGES.map((language) => ({ language, recipe: RECIPES[language] }))
    )
    for (const result of pulled) {
      console.log('  ' + (result.ok ? 'ok  ' : 'FAIL') + '  ' + result.language + '  ' + result.image)
      if (!result.ok) console.log('        ' + result.stderr.trim().split('\n')[0])
    }
    console.log('')
  }

  const isolation = describeIsolation(backend)

  console.log('Backend: ' + backend)
  console.log('')
  console.log('Limits per run')
  console.log('  timeout          ' + isolation.limits.timeoutMs + ' ms')
  console.log('  output           ' + isolation.limits.outputBytes + ' bytes')
  console.log('  memory           ' + isolation.limits.memoryMb + ' MB')
  console.log('  cpu              ' + isolation.limits.cpus)
  console.log('  processes        ' + isolation.limits.processes)
  console.log('  network          ' + (isolation.limits.network ? 'ENABLED' : 'disabled'))
  console.log('')

  console.log('Enforcement')
  for (const control of CONTROLS) {
    const state = isolation.enforcement[control]
    console.log('  ' + (state === 'enforced' ? '[x] ' : '[ ] ') + CONTROL_LABELS[control])
  }
  console.log('')

  const languages = await listRunnable()
  console.log('Languages')
  for (const entry of languages) {
    console.log(
      '  ' + tick(entry.available).padEnd(4) + entry.language.padEnd(12) + (entry.version || entry.toolchain)
    )
  }
  console.log('')

  if (isolation.weak) {
    console.log('WARNING: programs are not contained on this deployment.')
    console.log('Unenforced: ' + isolation.unenforced.join(', '))
    console.log('A program can read this machine and reach its network.')
    console.log('Set SANDBOX_BACKEND=docker to refuse to run code rather than run it this way.')

    if (strict) process.exitCode = 1
    return
  }

  const missing = languages.filter((entry) => !entry.available).map((entry) => entry.language)
  if (missing.length) {
    console.log('Not runnable here: ' + missing.join(', '))
    console.log('Run with --pull to fetch the images.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

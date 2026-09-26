import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { env } from '../../../../config/env.js'
import { logger } from '../../../../config/logger.js'
import { codeOf, credentials, describeError, loadSdk, statusOf } from './sdk.js'

/**
 * The machine every run starts from, and how it comes to exist.
 *
 * A run is a fresh microVM with no network, so it cannot install anything —
 * the compilers have to be in the image it boots from. Vercel's own images
 * carry Node and Python and nothing else, and building an image of our own
 * would mean asking whoever deploys this to install Docker and push to a
 * registry. So the server builds it: one builder machine, with network, runs
 * setup.sh, and is saved as a snapshot that never expires.
 *
 * That happens once per recipe, not once per start. The builder is named
 * after a hash of setup.sh and the image beneath it, and the snapshot is found
 * again by that name on every later start — a free-plan server that sleeps
 * after fifteen idle minutes would otherwise rebuild its compilers every time
 * somebody woke it. Change setup.sh and the name changes with it, so a new
 * snapshot is built rather than an old one quietly reused.
 */

/** What the builder starts from: Ubuntu 26.04 with Node 24 already on it. */
export const BASE_IMAGE = 'vercel/sandbox/node:24'

const SETUP_SCRIPT = readFileSync(new URL('./setup.sh', import.meta.url), 'utf8')

export const RECIPE = createHash('sha256')
  .update(BASE_IMAGE + '\n' + SETUP_SCRIPT)
  .digest('hex')
  .slice(0, 12)

/** Tags every sandbox this server makes carries, so they can be found again. */
export const APP_TAG = 'syncspace'

/**
 * One builder per recipe per region.
 *
 * Region is in the name because snapshots cannot leave the region they were
 * taken in: moving the runs to another region needs a snapshot there.
 */
export const builderName = () => 'syncspace-toolchains-' + RECIPE + '-' + env.SANDBOX_REGION

/**
 * Generous, because it is apt: an install that is merely slow must not be
 * mistaken for one that failed. It is also the ceiling on what a stuck build
 * can cost, since the machine stops itself when it passes.
 */
const BUILD_TIMEOUT_MS = 20 * 60 * 1000

/** Two vCPUs for the build only; runs get what SANDBOX_CPUS says. */
const BUILD_VCPUS = 2

/** How long a failed build is left alone before the next start or probe tries again. */
export const RETRY_AFTER_MS = 5 * 60 * 1000

/** Starting the builder and handing it setup.sh: long enough for a cold region. */
const BOOT_TIMEOUT_MS = 2 * 60 * 1000

/** How long an old recipe's snapshot must go unused before it is deleted. */
const RETIRE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The most any single bookkeeping call may take — a list, a lookup, a delete.
 *
 * Without one, a request that never answers leaves the toolchains "checking"
 * for as long as the process lives, and every language says it is being set
 * up, forever, with nothing in the logs.
 */
const CONTROL_TIMEOUT_MS = 30 * 1000
const quickly = () => AbortSignal.timeout(CONTROL_TIMEOUT_MS)

/**
 * Where the toolchains have got to.
 *
 *   idle      nothing has asked yet
 *   checking  looking for a snapshot built on an earlier start
 *   building  none was found; the builder is installing
 *   ready     `snapshotId` is what runs boot from
 *   failed    `reason` says why; tried again after RETRY_AFTER_MS
 */
let state = { status: 'idle', snapshotId: null, versions: {}, reason: null, failedAt: 0 }
let inflight = null

export const toolchainState = () => state

/** Test seam, and what the backend's reset calls. */
export function resetToolchain() {
  state = { status: 'idle', snapshotId: null, versions: {}, reason: null, failedAt: 0 }
  inflight = null
}

/**
 * Forgets a snapshot that turned out not to exist.
 *
 * Somebody can delete it from the Vercel dashboard, and a snapshot that is
 * gone is the same problem as one that was never built — except that the
 * server believes otherwise until a run fails. The run that finds out cannot
 * wait minutes for a rebuild, but the next one should not fail the same way.
 */
export function forgetSnapshot(snapshotId) {
  if (state.snapshotId !== snapshotId) return
  logger.warn({ snapshotId }, 'the toolchain snapshot is gone; building it again')
  state = { status: 'idle', snapshotId: null, versions: {}, reason: null, failedAt: 0 }
  prepareToolchain().catch(() => {})
}

/**
 * Makes sure a snapshot exists or is on its way, and returns the promise of it.
 *
 * Deduplicated: the boot-time kick-off, every /runners request and every run
 * all call this, and there must only ever be one builder at a time.
 */
export function prepareToolchain() {
  if (state.status === 'ready') return Promise.resolve(state.snapshotId)
  if (inflight) return inflight

  if (state.status === 'failed' && Date.now() - state.failedAt < RETRY_AFTER_MS) {
    return Promise.reject(new Error(state.reason))
  }

  inflight = prepare().finally(() => {
    inflight = null
  })
  return inflight
}

async function prepare() {
  const creds = credentials()
  const name = builderName()

  state = { ...state, status: 'checking', reason: null }

  try {
    // Without these the SDK would go looking for an OIDC token, which only
    // exists on Vercel, and fail with advice about `vercel link`.
    if (!creds) throw new Error('VERCEL_TOKEN, VERCEL_TEAM_ID and VERCEL_PROJECT_ID must all be set')

    const sdk = await loadSdk()

    const existing = await findSnapshot(sdk, creds, name)
    if (existing) {
      state = {
        status: 'ready',
        snapshotId: existing.id,
        versions: await recordedVersions(sdk, creds, name),
        reason: null,
        failedAt: 0,
      }
      logger.info({ snapshotId: existing.id, builder: name }, 'sandbox toolchains found')
      tidy(sdk, creds, name)
      return existing.id
    }

    state = { ...state, status: 'building' }
    logger.info({ builder: name, image: BASE_IMAGE }, 'building the sandbox toolchains (first start only)')

    const built = await build(sdk, creds, name)
    state = { status: 'ready', snapshotId: built.snapshotId, versions: built.versions, reason: null, failedAt: 0 }
    logger.info({ snapshotId: built.snapshotId, versions: built.versions }, 'sandbox toolchains ready')

    tidy(sdk, creds, name)
    return built.snapshotId
  } catch (error) {
    const reason = 'the sandbox toolchains could not be prepared: ' + describeError(error)
    state = { ...state, status: 'failed', reason, failedAt: Date.now() }
    logger.error({ err: error, builder: name }, reason)
    throw new Error(reason, { cause: error })
  }
}

/** The newest usable snapshot the builder of this recipe left, if any. */
async function findSnapshot(sdk, creds, name) {
  const page = await sdk.Snapshot.list({ ...creds, name, sortOrder: 'desc', limit: 20, signal: quickly() })

  return (
    (page.snapshots ?? []).find(
      (snapshot) =>
        snapshot.status === 'created' &&
        (snapshot.regions ?? [snapshot.region]).includes(env.SANDBOX_REGION)
    ) ?? null
  )
}

/**
 * Runs setup.sh on a builder and saves the result.
 *
 * A builder left over from an earlier attempt — a start that was killed half
 * way through, a deploy that replaced the process mid-build — would make the
 * name unavailable, so it is removed first. It never has a snapshot worth
 * keeping: `findSnapshot` would have returned it.
 */
async function build(sdk, creds, name) {
  await removeSandbox(sdk, creds, name)

  const builder = await sdk.Sandbox.create({
    ...creds,
    name,
    image: BASE_IMAGE,
    region: env.SANDBOX_REGION,
    resources: { vcpus: BUILD_VCPUS },
    timeout: BUILD_TIMEOUT_MS,
    // It needs the Ubuntu archive. Nothing but setup.sh ever runs here.
    networkPolicy: 'allow-all',
    // Saved once, explicitly, below; stopping must not save it again.
    persistent: false,
    tags: { app: APP_TAG, role: 'toolchains', recipe: RECIPE },
    signal: AbortSignal.timeout(BOOT_TIMEOUT_MS),
  })

  let snapshotted = false

  try {
    await builder.writeFiles([{ path: '/tmp/syncspace-setup.sh', content: SETUP_SCRIPT, mode: 0o755 }], {
      signal: AbortSignal.timeout(BOOT_TIMEOUT_MS),
    })

    const setup = await builder.runCommand({
      cmd: 'bash',
      args: ['/tmp/syncspace-setup.sh'],
      sudo: true,
      // The machine stops itself at BUILD_TIMEOUT_MS; this is for a
      // connection that goes quiet without the machine noticing.
      signal: AbortSignal.timeout(BUILD_TIMEOUT_MS + 60 * 1000),
    })

    const stdout = await setup.stdout()

    if (setup.exitCode !== 0) {
      const stderr = await setup.stderr()
      const tail = (stderr || stdout).trim().split('\n').slice(-8).join('\n')
      throw new Error('setup.sh exited with ' + setup.exitCode + ':\n' + tail)
    }

    const versions = parseVersions(stdout)

    // Written onto the builder so a later start can report them without
    // booting anything. Nice to have, so never fatal.
    await builder
      .update({ tags: { app: APP_TAG, role: 'toolchains', recipe: RECIPE, versions: encodeVersions(versions) } })
      .catch((error) => logger.warn({ err: error }, 'could not record toolchain versions'))

    // No expiry: runs keep the snapshot in use, but a quiet month should not
    // mean the next person to press Run waits for apt. An account that may
    // not keep snapshots for ever gets Vercel's default instead — thirty days
    // from last use — rather than a build thrown away at its last step; if
    // it does lapse, the next start builds it again.
    let snapshot
    try {
      snapshot = await builder.snapshot({ expiration: 0 })
    } catch (error) {
      const status = statusOf(error)
      if (status !== 400 && status !== 422) throw error
      logger.warn({ err: error }, 'a snapshot that never expires was refused; keeping Vercel\'s default expiry')
      snapshot = await builder.snapshot()
    }
    snapshotted = true

    return { snapshotId: snapshot.snapshotId, versions }
  } finally {
    // Taking a snapshot stops the machine. Anything else that ends up here —
    // a failed install, a lost connection — would otherwise leave a two-vCPU
    // machine running until its timeout.
    if (!snapshotted) {
      await builder.stop().catch(() => {})
    }
  }
}

/** Deletes a named sandbox if there is one, without booting it first. */
async function removeSandbox(sdk, creds, name) {
  try {
    const existing = await sdk.Sandbox.get({ ...creds, name, resume: false, signal: quickly() })
    await existing.delete({ signal: quickly() })
    logger.info({ builder: name }, 'removed an unfinished toolchain builder')
  } catch (error) {
    if (statusOf(error) === 404 || codeOf(error) === 'not_found') return
    throw error
  }
}

/** Tidying, and never the reason anything fails. */
function tidy(sdk, creds, current) {
  retireOldBuilders(sdk, creds, current).catch((error) => {
    logger.warn({ err: error }, 'could not remove superseded toolchain builders')
  })
}

/**
 * Removes builders from earlier recipes, and the snapshots only they used.
 *
 * Their snapshots never expire, so without this every change to setup.sh
 * would leave a couple of gigabytes behind for good — and snapshot storage is
 * one of the things the free plan counts.
 *
 * Only once nothing has booted from one for a week. Another deployment of
 * this app — a staging server a version behind — may share the Vercel
 * project and still be running on the old recipe, and deleting its snapshot
 * would send it off to build the same thing again, and then to delete this
 * one.
 */
async function retireOldBuilders(sdk, creds, current) {
  const page = await sdk.Sandbox.list({ ...creds, tags: { role: 'toolchains' }, limit: 50, signal: quickly() })

  for (const sandbox of page.sandboxes ?? []) {
    if (sandbox.name === current || sandbox.tags?.app !== APP_TAG) continue

    const snapshots = await sdk.Snapshot.list({ ...creds, name: sandbox.name, limit: 20, signal: quickly() })
    const lastUsed = Math.max(
      sandbox.createdAt ?? 0,
      ...(snapshots.snapshots ?? []).map((snapshot) => snapshot.lastUsedAt ?? snapshot.createdAt ?? 0)
    )
    if (Date.now() - lastUsed < RETIRE_AFTER_MS) continue

    const old = await sdk.Sandbox.get({ ...creds, name: sandbox.name, resume: false, signal: quickly() })
    await old.delete({ deleteOrphanSnapshots: true, signal: quickly() })
    logger.info({ builder: sandbox.name }, 'removed a superseded toolchain builder')
  }
}

/** Versions a previous build wrote onto its builder, or none. */
async function recordedVersions(sdk, creds, name) {
  try {
    const builder = await sdk.Sandbox.get({ ...creds, name, resume: false, signal: quickly() })
    return decodeVersions(builder.tags?.versions)
  } catch {
    return {}
  }
}

/** `syncspace-version <language> <anything>` lines, as setup.sh prints them. */
export function parseVersions(output) {
  const versions = {}
  for (const line of String(output).split('\n')) {
    const match = /^syncspace-version (\S+) (.+)$/.exec(line.trim())
    if (match) versions[match[1]] = match[2].trim().slice(0, 80)
  }
  return versions
}

/**
 * Versions as one tag value.
 *
 * A sandbox gets five tags of 256 characters, so this keeps only the part of
 * each line that is a version number and joins them compactly.
 */
export function encodeVersions(versions) {
  return Object.entries(versions)
    .map(([language, text]) => language + '=' + (/\d[\w.+-]*/.exec(text)?.[0] ?? '?'))
    .join(';')
    .slice(0, 256)
}

export function decodeVersions(tag) {
  const versions = {}
  for (const pair of String(tag || '').split(';')) {
    const [language, version] = pair.split('=')
    if (language && version) versions[language] = version
  }
  return versions
}

/**
 * Runs the server against a throwaway in-memory MongoDB.
 *
 * For machines without Docker or a local mongod. Everything written is lost
 * when the process exits — use docker-compose for a database that persists.
 */
import { spawn } from 'node:child_process'
import { MongoMemoryServer } from 'mongodb-memory-server'

const mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } })
const uri = mongod.getUri('syncspace')

process.stdout.write('[dev-memory] ephemeral mongodb ready (data is not persisted)\n')

const child = spawn(process.execPath, ['--watch', 'src/index.js'], {
  stdio: 'inherit',
  env: { ...process.env, MONGODB_URI: uri },
})

let stopping = false
async function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  if (!child.killed) child.kill('SIGTERM')
  await mongod.stop()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
child.on('exit', (code) => shutdown(code ?? 0))

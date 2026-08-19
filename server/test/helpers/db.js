import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'

let mongod = null

export async function startMemoryMongo() {
  mongod = await MongoMemoryServer.create({ binary: { version: '7.0.14' } })
  const uri = mongod.getUri('syncspace-test')
  await mongoose.connect(uri)
  return uri
}

export async function stopMemoryMongo() {
  await mongoose.disconnect()
  if (mongod) await mongod.stop()
  mongod = null
}

/**
 * Clears through the native driver rather than the models, because DocUpdate
 * blocks deletes at the Mongoose layer by design.
 */
export async function clearDatabase() {
  const collections = Object.values(mongoose.connection.collections)
  await Promise.all(collections.map((collection) => collection.deleteMany({})))
}

/** Polls until `check` returns truthy, or fails after `timeout` ms. */
export async function waitFor(check, { timeout = 8000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const result = await check()
    if (result) return result
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + label)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

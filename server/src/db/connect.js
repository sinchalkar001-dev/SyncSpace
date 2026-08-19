import mongoose from 'mongoose'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'

mongoose.set('strictQuery', true)

export async function connectDatabase(uri = env.MONGODB_URI) {
  mongoose.connection.on('disconnected', () => logger.warn('mongodb disconnected'))
  mongoose.connection.on('reconnected', () => logger.info('mongodb reconnected'))

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 20,
  })

  logger.info({ db: mongoose.connection.name }, 'mongodb connected')
  return mongoose.connection
}

export async function disconnectDatabase() {
  await mongoose.disconnect()
}

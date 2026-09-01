import request from 'supertest'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDatabase, startMemoryMongo, stopMemoryMongo, waitFor } from './helpers/db.js'
import { createApp } from '../src/app.js'
import { createMailer, maskEmail, mailer } from '../src/services/email.service.js'
import { logger } from '../src/config/logger.js'

beforeAll(startMemoryMongo)
afterAll(stopMemoryMongo)

const ALICE = { email: 'alice@syncspace.test', password: 'correct-horse-battery', name: 'Alice' }

describe('maskEmail', () => {
  it('hides the local part but keeps the domain readable', () => {
    expect(maskEmail('alice@syncspace.test')).toBe('a***@syncspace.test')
    expect(maskEmail('long.name+tag@mail.example.co.uk')).toBe('l***@mail.example.co.uk')
  })

  it('never leaks anything for malformed addresses', () => {
    expect(maskEmail('@domain-only')).toBe('***')
    expect(maskEmail(undefined)).toBe('***')
  })
})

describe('createMailer', () => {
  it('hands the composed message to the configured transport', async () => {
    const sent = []
    const box = createMailer({
      transport: { sendMail: async (message) => sent.push(message) },
      from: 'SyncSpace <no-reply@syncspace.test>',
    })

    const result = await box.send({ to: ALICE.email, subject: 'Hi', text: 'body', html: '<p>body</p>' })

    expect(result).toEqual({ delivered: true })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      from: 'SyncSpace <no-reply@syncspace.test>',
      to: ALICE.email,
      subject: 'Hi',
      html: '<p>body</p>',
    })
  })

  it('answers { delivered: false } instead of throwing when the relay fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const box = createMailer({
      transport: {
        sendMail: async () => {
          throw Object.assign(new Error('535 auth failed'), { code: 'EAUTH' })
        },
      },
      from: 'no-reply@syncspace.test',
    })

    const result = await box.send({ to: ALICE.email, subject: 'Hi', text: 'body' })

    expect(result).toEqual({ delivered: false })
    // Safe failure logging: masked recipient, error class only — never the
    // provider's message, which can echo credentials or relay banners.
    const [context] = warnSpy.mock.calls[0]
    expect(context.to).toBe('a***@syncspace.test')
    expect(context.code).toBe('EAUTH')
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(ALICE.email)
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('535')
    warnSpy.mockRestore()
  })

  it('logs the message itself when no transport is configured', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const box = createMailer({ transport: null, from: undefined })

    const url = 'https://app.test/verify-email?token=' + 'f'.repeat(64)
    const result = await box.send({ to: ALICE.email, subject: 'Verify', text: 'Open ' + url })

    expect(result).toEqual({ delivered: false })
    expect(infoSpy.mock.calls[0][0].to).toBe('a***@syncspace.test')
    expect(infoSpy.mock.calls[0][1]).toContain(url)
    infoSpy.mockRestore()
  })
})

describe('email failure isolation', () => {
  let app

  beforeEach(async () => {
    await clearDatabase()
    app = createApp()
  })

  it('a dead provider never fails sign-up or resend', async () => {
    const failing = vi.spyOn(mailer, 'send').mockResolvedValue({ delivered: false })

    const registered = await request(app).post('/api/v1/auth/register').send(ALICE)
    expect(registered.status).toBe(201)

    const resent = await request(app)
      .post('/api/v1/auth/resend-verification')
      .set('Authorization', 'Bearer ' + registered.body.token)
    expect(resent.status).toBe(200)
    expect(resent.body).toEqual({ sent: true })

    failing.mockRestore()
  })

  /**
   * The verification send is deliberately not awaited — registration has
   * already answered by the time it settles — so a rejection would have nobody
   * left to catch it, and an unhandled rejection ends the process, taking every
   * open room down with it. Reporting failure is not enough: it has to survive
   * a mailer that throws.
   */
  it('a mailer that throws never escapes as an unhandled rejection', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const escaped = vi.fn()
    process.on('unhandledRejection', escaped)

    const throwing = vi
      .spyOn(mailer, 'send')
      .mockRejectedValue(Object.assign(new Error('535 auth failed'), { code: 'EAUTH' }))

    const registered = await request(app).post('/api/v1/auth/register').send(ALICE)
    expect(registered.status).toBe(201)

    await waitFor(
      () => warnSpy.mock.calls.some(([, message]) => message === 'could not send the verification email'),
      { label: 'the failed verification email to be logged' }
    )
    expect(escaped).not.toHaveBeenCalled()

    // Same discipline as every other mail failure: the error class, nothing else.
    const [context] = warnSpy.mock.calls.find(
      ([, message]) => message === 'could not send the verification email'
    )
    expect(context).toEqual({ code: 'EAUTH' })
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('535')

    process.off('unhandledRejection', escaped)
    throwing.mockRestore()
    warnSpy.mockRestore()
  })
})

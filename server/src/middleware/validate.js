import { badRequest } from '../errors.js'

/**
 * Validates one part of the request against a zod schema and replaces it with
 * the parsed value, so handlers only ever see coerced, trusted data.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source])

    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => issue.path.join('.') + ': ' + issue.message)
        .join('; ')
      next(badRequest(detail, 'validation_failed'))
      return
    }

    if (source === 'body') req.body = result.data
    else req.validated = { ...(req.validated || {}), [source]: result.data }

    next()
  }
}

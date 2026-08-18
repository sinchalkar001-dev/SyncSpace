export class AppError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'AppError'
    this.status = status
    this.code = code || 'error'
  }
}

export const badRequest = (m, c) => new AppError(400, m, c || 'bad_request')
export const unauthorized = (m, c) => new AppError(401, m || 'Unauthorized', c || 'unauthorized')
export const forbidden = (m, c) => new AppError(403, m || 'Forbidden', c || 'forbidden')
export const notFound = (m, c) => new AppError(404, m || 'Not found', c || 'not_found')
export const conflict = (m, c) => new AppError(409, m, c || 'conflict')

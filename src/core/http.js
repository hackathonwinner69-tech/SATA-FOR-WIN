/** An expected request failure; callers may attach provider-specific details separately. */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Keep JSON responses and failure handling consistent across every API route. */
export const jsonRoute = (handler) => async (req, res, next) => {
  try {
    res.json(await handler(req, res));
  } catch (error) {
    errorHandler(error, req, res, next);
  }
};

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
  const message = error.type === 'entity.parse.failed' ? 'request body must be valid JSON' : error.message || 'request failed';
  res.status(status).json({ error: message });
}

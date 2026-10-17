import type { NextFunction, Request, Response } from 'express';
import { ConflictError, DomainValidationError, NotFoundError } from '../domain/errors';

// Single error envelope: clients (and the dashboard) can always read
// error.code + error.message, whatever went wrong.
function sendError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** Terminal 404 for /api/* requests that matched no route. */
export function notFoundHandler(req: Request, res: Response): void {
  sendError(res, 404, 'NOT_FOUND', `Unknown API route: ${req.method} ${req.originalUrl}`);
}

function isJsonBodyError(err: unknown): err is SyntaxError & { type: string } {
  return err instanceof SyntaxError && 'type' in err && err.type === 'entity.parse.failed';
}

/**
 * Maps every failure to the JSON envelope. Domain errors carry the status
 * semantics; anything unexpected is logged server-side and masked, so
 * internals never reach the client.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    // Express can no longer respond safely; delegate to its default handler.
    next(err);
    return;
  }
  if (err instanceof DomainValidationError) {
    sendError(res, 400, 'VALIDATION', err.message);
    return;
  }
  if (err instanceof NotFoundError) {
    sendError(res, 404, 'NOT_FOUND', err.message);
    return;
  }
  if (err instanceof ConflictError) {
    sendError(res, 409, 'CONFLICT', err.message);
    return;
  }
  if (isJsonBodyError(err)) {
    sendError(res, 400, 'VALIDATION', err.message);
    return;
  }
  console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  sendError(res, 500, 'INTERNAL', 'Unexpected server error');
}

import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError, type ZodSchema } from 'zod';

export type ErrorCode = 'INVALID_JSON' | 'VALIDATION_ERROR' | 'DUPLICATE' | 'NOT_FOUND' | 'CONSTRAINT';

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200): Response {
  return c.json({ data }, status);
}

export function fail(c: Context, message: string, code: ErrorCode, status: ContentfulStatusCode = 400): Response {
  return c.json({ error: { message, code } }, status);
}

function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

function validate<T>(c: Context, input: unknown, schema: ZodSchema<T>, fallback: string): Parsed<T> {
  try {
    return { ok: true, data: schema.parse(input) };
  } catch (err) {
    const message = err instanceof ZodError ? zodMessage(err) : fallback;
    return { ok: false, response: fail(c, message, 'VALIDATION_ERROR', 400) };
  }
}

export async function parseJson<T>(c: Context, schema: ZodSchema<T>): Promise<Parsed<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, response: fail(c, 'Invalid JSON body', 'INVALID_JSON', 400) };
  }
  return validate(c, body, schema, 'Invalid input');
}

export function parseQuery<T>(c: Context, schema: ZodSchema<T>): Parsed<T> {
  return validate(c, c.req.query(), schema, 'Invalid query');
}

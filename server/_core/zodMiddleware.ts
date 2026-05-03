/**
 * Express middleware that validates `req.body` / `req.query` / `req.params`
 * against a zod schema before the handler runs (B8).
 *
 * On failure the response is the same shape that tRPC errors use, so
 * the UI can render either source uniformly:
 *   400  { error: { issues: [{ path: string[], message: string }] } }
 *
 * On success, the parsed (and type-narrowed) value is written back to
 * the corresponding request property — so handlers can do
 * `const { instrument, data } = (req.body as z.infer<typeof schema>)`
 * with confidence the shape is right and any default values are filled.
 *
 * Schemas should be `.strict()` to reject unknown keys at the boundary.
 * That's the actual safety win — type-safe parsing alone won't catch a
 * typo'd field that gets persisted to MongoDB unmolested.
 */
import type { Request, Response, NextFunction } from "express";
import type { ZodSchema, ZodError } from "zod";

function formatIssues(err: ZodError): { path: (string | number)[]; message: string }[] {
  return err.issues.map((i) => ({ path: i.path, message: i.message }));
}

function reject(res: Response, err: ZodError, where: "body" | "query" | "params") {
  res.status(400).json({
    error: {
      where,
      issues: formatIssues(err),
    },
  });
}

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) return reject(res, result.error, "body");
    req.body = result.data;
    next();
  };
}

export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);
    if (!result.success) return reject(res, result.error, "query");
    // req.query is typed as ParsedQs and is read-only in some Express
    // versions — write back via Object.assign to keep handlers' typed
    // access working without TS complaints.
    Object.assign(req.query, result.data as Record<string, unknown>);
    next();
  };
}

export function validateParams<T>(schema: ZodSchema<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.params);
    if (!result.success) return reject(res, result.error, "params");
    Object.assign(req.params, result.data as Record<string, unknown>);
    next();
  };
}

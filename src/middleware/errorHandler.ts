import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Malformed request bodies are the client's fault — answer 400 with the
  // first validation message instead of a misleading 500. (Resolves the
  // long-standing "Zod errors return 500" issue noted in BRAIN.md.)
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const field = first?.path?.length ? `${first.path.join(".")}: ` : "";
    return res.status(400).json({ error: `${field}${first?.message ?? "Invalid request body"}` });
  }
  // Never leak stack traces or internal error text to the client.
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: "Internal server error" });
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: "Not found" });
}

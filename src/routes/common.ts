// Shared route helpers: AppError → clean JSON; input checking.
import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { AppError } from "../services/people.js";

export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof AppError) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  };

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new AppError(400, `${first.path.join(".") || "input"}: ${first.message}`);
  }
  return r.data;
}

/** The logged-in user's organisation id. Routes behind requireOrg can rely on it. */
export const orgOf = (req: Request) => req.user!.orgId!;

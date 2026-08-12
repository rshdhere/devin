import type { NextFunction, Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "../lib/auth.js";
import { applyCorsHeaders } from "../lib/cors.js";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    applyCorsHeaders(res, req.headers.origin, req.hostname);
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  req.auth = session;
  next();
}

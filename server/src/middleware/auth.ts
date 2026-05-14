/**
 * requireAuth — verifies the Supabase JWT in `Authorization: Bearer <token>`
 * and attaches `req.user = { id, email }` on success.
 *
 * Use this on any route that needs an authenticated user.
 */

import type { Request, Response, NextFunction } from "express";
import { db } from "../db";

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing or malformed Authorization header" });
  }

  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = {
    id: data.user.id,
    email: data.user.email ?? null,
  };

  next();
}

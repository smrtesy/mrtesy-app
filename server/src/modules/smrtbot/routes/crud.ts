/**
 * smrtBot — generic per-bot CRUD router factory.
 *
 * Most smrtBot resources are simple org+bot-scoped tables that need the same
 * list/create/update/delete shape. This factory builds one router per table
 * so the route handlers stay uniform and the `{ error }` handling can't be
 * forgotten. Resources with special behaviour (settings upsert, questions
 * reply, publish) get their own handlers instead.
 *
 * Routes (mounted under the smrtBot auth chain):
 *   GET    /bot/:botId/<resource>
 *   POST   /bot/:botId/<resource>
 *   PATCH  /bot/:botId/<resource>/:id
 *   DELETE /bot/:botId/<resource>/:id
 */
import { Router } from "express";
import type { Request, Response } from "express";

import { db } from "../../../db";
import { notifyError } from "../../../lib/platform";
import { requireBotAccess } from "../require-bot-access";

export interface CrudOpts {
  resource: string;
  table: string;
  /** Fields a client may set on create/update. */
  updatable: string[];
  /** Fields required (non-empty) on create. */
  required?: string[];
  /** Column to order list results by (default created_at). */
  orderBy?: string;
  /** When true, list supports an ?env=test|live filter. */
  hasEnv?: boolean;
}

function pick(body: Record<string, unknown>, allowed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of allowed) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

export function makeCrudRouter(opts: CrudOpts): Router {
  const router = Router();
  const { resource, table, updatable, required = [], orderBy = "created_at" } = opts;
  const base = `/bot/:botId/${resource}`;

  router.use(`/bot/:botId/${resource}`, requireBotAccess("botId"));

  // List
  router.get(base, async (req: Request, res: Response) => {
    let q = db
      .from(table)
      .select("*")
      .eq("org_id", req.org!.id)
      .eq("bot_id", req.params.botId);
    if (opts.hasEnv && typeof req.query.env === "string") {
      q = q.eq("env", req.query.env);
    }
    const { data, error } = await q.order(orderBy, { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ [resource]: data ?? [] });
  });

  // Create
  router.post(base, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    for (const field of required) {
      const v = body[field];
      if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
        return res.status(400).json({ error: `${field} is required` });
      }
    }
    const insert = {
      ...pick(body, updatable),
      org_id: req.org!.id,
      bot_id: req.params.botId,
    };
    const { data, error } = await db.from(table).insert(insert).select("*").single();
    if (error) {
      await notifyError(req.org!.id, "smrtbot", {
        title: `Failed to create ${resource}`,
        body: error.message,
      });
      return res.status(500).json({ error: error.message });
    }
    res.status(201).json({ item: data });
  });

  // Update
  router.patch(`${base}/:id`, async (req: Request, res: Response) => {
    const updates = pick((req.body ?? {}) as Record<string, unknown>, updatable);
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }
    const { data, error } = await db
      .from(table)
      .update(updates)
      .eq("org_id", req.org!.id)
      .eq("bot_id", req.params.botId)
      .eq("id", req.params.id)
      .select("*")
      .single();
    if (error) {
      await notifyError(req.org!.id, "smrtbot", {
        title: `Failed to update ${resource}`,
        body: error.message,
      });
      return res.status(500).json({ error: error.message });
    }
    res.json({ item: data });
  });

  // Delete
  router.delete(`${base}/:id`, async (req: Request, res: Response) => {
    const { error } = await db
      .from(table)
      .delete()
      .eq("org_id", req.org!.id)
      .eq("bot_id", req.params.botId)
      .eq("id", req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  });

  return router;
}

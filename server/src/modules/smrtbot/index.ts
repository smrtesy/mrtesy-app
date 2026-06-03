/**
 * smrtBot module — WhatsApp conversational engine + WhatsApp transport.
 *
 * Self-contained (modules/smrtbot + apps/smrtbot). The inbound WhatsApp
 * webhook lives as a Next.js route on Vercel (per-bot, by slug), NOT here —
 * Railway dyno restarts drop inbound messages, so the webhook stays on Vercel
 * like smrtTask's. This module hosts the authenticated admin/API routes and,
 * later, the send-service + cron job routes.
 */

import { Router } from "express";
import smrtbotRoutes from "./routes";

const router = Router();
router.use(smrtbotRoutes);

export default router;

import type { AppManifest } from "./types";
import { manifest as smrttaskManifest } from "../../apps/smrttask/manifest";
import { manifest as smrtvoiceManifest } from "../../apps/smrtvoice/manifest";
import { manifest as smrtbotManifest } from "../../apps/smrtbot/manifest";

/**
 * All app manifests registered here.
 * Add a new manifest import + entry when building a new app.
 */
export const APP_REGISTRY: AppManifest[] = [
  smrttaskManifest,
  smrtvoiceManifest,
  smrtbotManifest,
];

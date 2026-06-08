/**
 * smrtBot — Baileys (unofficial WhatsApp transport) public surface.
 */
export {
  startConnection,
  initBaileysConnections,
  logoutConnection,
  syncGroups,
  liveStatus,
  sendBaileysText,
  sendBaileysImage,
  toJid,
  type WaStatus,
  type BaileysSendResult,
} from "./connection";

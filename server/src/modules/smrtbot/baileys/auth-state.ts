/**
 * smrtBot — Baileys auth-state backed by Supabase.
 *
 * Drop-in replacement for Baileys' `useMultiFileAuthState`: Railway's
 * filesystem is ephemeral (a dyno restart would drop the linked-device
 * session and force a re-scan), so every auth artifact is persisted to the
 * `smrtbot_wa_auth` table instead — one row for `creds`, one per signal key.
 *
 * Buffers inside the state are serialized with Baileys' BufferJSON helpers so
 * they survive the round-trip through a jsonb column.
 */
import {
  initAuthCreds,
  BufferJSON,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

import { db } from "../../../db";

type KeyData = { [id: string]: unknown };

export interface SupabaseAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function useSupabaseAuthState(
  orgId: string,
  botId: string,
): Promise<SupabaseAuthState> {
  async function readData(key: string): Promise<unknown | null> {
    const { data, error } = await db
      .from("smrtbot_wa_auth")
      .select("value")
      .eq("bot_id", botId)
      .eq("auth_key", key)
      .maybeSingle();
    if (error) {
      console.error("[baileys/auth] read", key, error.message);
      return null;
    }
    if (!data) return null;
    // Revive Buffers from the BufferJSON shape stored in jsonb.
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
  }

  async function writeData(key: string, value: unknown): Promise<void> {
    const serialized = JSON.parse(JSON.stringify(value, BufferJSON.replacer));
    const { error } = await db.from("smrtbot_wa_auth").upsert(
      {
        org_id: orgId,
        bot_id: botId,
        auth_key: key,
        value: serialized,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "bot_id,auth_key" },
    );
    if (error) console.error("[baileys/auth] write", key, error.message);
  }

  async function removeData(key: string): Promise<void> {
    const { error } = await db
      .from("smrtbot_wa_auth")
      .delete()
      .eq("bot_id", botId)
      .eq("auth_key", key);
    if (error) console.error("[baileys/auth] remove", key, error.message);
  }

  const creds: AuthenticationCreds =
    ((await readData("creds")) as AuthenticationCreds | null) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const result: KeyData = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === "app-state-sync-key" && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(
                  value as Record<string, unknown>,
                );
              }
              result[id] = value;
            }),
          );
          return result as { [id: string]: SignalDataTypeMap[typeof type] };
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            const cat = data[category as keyof typeof data] ?? {};
            for (const id in cat) {
              const value = (cat as KeyData)[id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData("creds", creds),
  };
}

/** Wipe every persisted auth artifact for a bot (used on logout). */
export async function clearAuthState(botId: string): Promise<void> {
  const { error } = await db.from("smrtbot_wa_auth").delete().eq("bot_id", botId);
  if (error) console.error("[baileys/auth] clear", botId, error.message);
}

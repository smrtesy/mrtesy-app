"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { api, ApiError } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Smartphone, Plus, Trash2, Copy, Check, Loader2, KeyRound, ScrollText, RefreshCw, ChevronDown } from "lucide-react";
import { toast } from "sonner";

interface SmsConnection {
  id: string;
  device_id: string;
  label: string | null;
  display_phone_number: string | null;
  connected_at: string;
  disconnected_at: string | null;
}

interface WebhookLogEntry {
  id: string;
  created_at: string;
  event: string | null;
  direction: string | null;
  outcome: "ingested" | "ignored" | "dropped";
  reason: string | null;
  message_id: string | null;
  peer: string | null;
  body_preview: string | null;
  device_id: string | null;
}

interface ConnectResult {
  webhook_url: string;
  signing_key: string;
  device_id: string;
}

/**
 * Registers the user's "SMS Gateway for Android" device so its received-SMS
 * webhook is trusted and routed to their account. The signing key is shown
 * exactly once (right after connecting) — the user pastes it, together with the
 * webhook URL, into the app's Settings → Webhooks. We only ever store the Vault
 * pointer, so the key cannot be read back.
 *
 * Compact by default: the "add device" form is collapsed behind a button and
 * only expands when the user chooses to connect a new device.
 */
export function SmsDeviceManager() {
  const t = useTranslations("sms");

  const [connections, setConnections] = useState<SmsConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [deviceId, setDeviceId] = useState("");
  const [label, setLabel] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Webhook diagnostic log — collapsed by default (compact-UI convention).
  const [logOpen, setLogOpen] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logRows, setLogRows] = useState<WebhookLogEntry[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ connections: SmsConnection[] }>("/api/sms/connections");
      setConnections((r.connections ?? []).filter((c) => !c.disconnected_at));
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadLog = useCallback(async () => {
    setLogLoading(true);
    try {
      const r = await api<{ log: WebhookLogEntry[] }>("/api/sms/webhook-log");
      setLogRows(r.log ?? []);
    } catch (e) {
      if (e instanceof ApiError && e.status !== 401) toast.error((e as Error).message);
    } finally {
      setLogLoading(false);
    }
  }, []);

  function toggleLog() {
    const next = !logOpen;
    setLogOpen(next);
    if (next) loadLog();
  }

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  }

  async function handleConnect() {
    const device = deviceId.trim();
    if (!device) return;
    setConnecting(true);
    try {
      const r = await api<ConnectResult>("/api/sms/connect", {
        method: "POST",
        body: { deviceId: device, label: label.trim() || undefined },
      });
      setResult(r);
      setDeviceId("");
      setLabel("");
      setFormOpen(false);
      toast.success(t("connected"));
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        toast.error(t("errorInUse"));
      } else {
        toast.error((e as Error).message);
      }
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect(id: string) {
    setRemovingId(id);
    try {
      await api("/api/sms/disconnect", { method: "POST", body: { id } });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {/* Tokenized webhook URL — shown once, right after a successful connect.
          The secret token is embedded in the URL, so this is the only value
          the user needs to register on the phone. */}
      {result && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-1.5">
          <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
            <KeyRound className="h-3.5 w-3.5" />
            {t("webhookReadyTitle")}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs" dir="ltr">
              {result.webhook_url}
            </code>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => copy(result.webhook_url, "url")}
              aria-label={t("copy")}
            >
              {copied === "url" ? <Check className="h-4 w-4 text-status-ok" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
          <p className="text-xs text-status-warn">{t("webhookReadyHint")}</p>
        </div>
      )}

      {/* Registered devices. */}
      {loading ? (
        <div className="space-y-2">
          {[1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}
        </div>
      ) : connections.length === 0 ? (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <ul className="space-y-2">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="flex items-center gap-2 min-w-0">
                <Smartphone className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" dir="auto">
                    {c.label || c.display_phone_number || t("deviceFallbackName")}
                  </p>
                  <p className="text-xs text-muted-foreground truncate" dir="ltr">{c.device_id}</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-destructive hover:bg-destructive/10"
                onClick={() => handleDisconnect(c.id)}
                disabled={removingId === c.id}
                aria-label={t("disconnect")}
              >
                {removingId === c.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Add-device form — collapsed by default. */}
      {formOpen ? (
        <div className="rounded-md border p-3 space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t("deviceIdLabel")}</label>
            <Input
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              placeholder={t("deviceIdPlaceholder")}
              dir="ltr"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t("labelLabel")}</label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t("labelPlaceholder")}
              dir="auto"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={handleConnect} disabled={connecting || !deviceId.trim()} className="flex-1 gap-2">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t("connect")}
            </Button>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={connecting}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button onClick={() => setFormOpen(true)} className="min-h-[48px] w-full gap-2">
          <Plus className="h-4 w-4" />
          {t("addDevice")}
        </Button>
      )}

      {/* Setup instructions. */}
      <div className="rounded-md border border-dashed p-3 space-y-1.5">
        <p className="text-xs font-medium">{t("instructionsTitle")}</p>
        <ol className="list-decimal space-y-1 ps-4 text-xs text-muted-foreground">
          <li>{t("step1")}</li>
          <li>{t("step2")}</li>
          <li>{t("step3")}</li>
          <li>{t("step4")}</li>
        </ol>
      </div>

      {/* Webhook diagnostic log — collapsed by default; one quiet entry point
          that expands on demand. Shows every hit our webhook received and what
          became of it, so the user can tell whether the phone is delivering. */}
      <div className="rounded-md border">
        <button
          type="button"
          onClick={toggleLog}
          className="flex w-full items-center justify-between gap-2 p-3 text-start"
          aria-expanded={logOpen}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <ScrollText className="h-4 w-4 text-muted-foreground" />
            {t("webhookLog")}
          </span>
          <span className="flex items-center gap-1.5">
            {logOpen && (
              <RefreshCw
                className={`h-3.5 w-3.5 text-muted-foreground ${logLoading ? "animate-spin" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!logLoading) loadLog();
                }}
                aria-label={t("webhookLogRefresh")}
              />
            )}
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${logOpen ? "rotate-180" : ""}`} />
          </span>
        </button>

        {logOpen && (
          <div className="border-t p-3">
            <p className="mb-2 text-xs text-muted-foreground">{t("webhookLogHint")}</p>
            {logLoading && logRows.length === 0 ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 rounded" />)}
              </div>
            ) : logRows.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                {t("webhookLogEmpty")}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {logRows.map((row) => (
                  <li key={row.id} className="rounded-md border p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className={outcomeClass(row.outcome)}>{t(outcomeKey(row.outcome))}</span>
                        {row.event && <code className="truncate rounded bg-muted px-1 py-0.5" dir="ltr">{row.event}</code>}
                        {row.peer && <span className="truncate text-muted-foreground" dir="ltr">{row.peer}</span>}
                      </span>
                      <time className="shrink-0 text-[11px] text-muted-foreground" dir="ltr">
                        {new Date(row.created_at).toLocaleString()}
                      </time>
                    </div>
                    {(row.reason || row.body_preview) && (
                      <p className="mt-1 truncate text-muted-foreground" dir="auto">
                        {row.reason ? <span dir="ltr">{row.reason}</span> : null}
                        {row.reason && row.body_preview ? " · " : null}
                        {row.body_preview}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function outcomeKey(outcome: WebhookLogEntry["outcome"]): "outcomeIngested" | "outcomeIgnored" | "outcomeDropped" {
  if (outcome === "ingested") return "outcomeIngested";
  if (outcome === "ignored") return "outcomeIgnored";
  return "outcomeDropped";
}

function outcomeClass(outcome: WebhookLogEntry["outcome"]): string {
  const base = "shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ";
  if (outcome === "ingested") return base + "bg-status-ok/10 text-status-ok";
  if (outcome === "ignored") return base + "bg-muted text-muted-foreground";
  return base + "bg-destructive/10 text-destructive";
}

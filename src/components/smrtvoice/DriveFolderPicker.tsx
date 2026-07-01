"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FolderOpen } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api/client";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    gapi?: any;
    google?: any;
  }
}

const API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;

/** Load an external script once, resolving when ready. */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.body.appendChild(s);
  });
}

/**
 * "Browse Drive" button that opens the Google Picker for a FOLDER and returns
 * its id + name. Renders nothing unless NEXT_PUBLIC_GOOGLE_API_KEY is set (the
 * Picker needs a browser API key with the Picker API enabled) — callers keep
 * their paste-a-link input as the always-available fallback.
 */
export function DriveFolderPicker({
  onPicked,
}: {
  onPicked: (folder: { id: string; name: string; url: string }) => void;
}) {
  const t = useTranslations("smrtVoice.scripts");
  const [busy, setBusy] = useState(false);

  if (!API_KEY) return null;

  async function open() {
    setBusy(true);
    try {
      await loadScript("https://apis.google.com/js/api.js");
      await new Promise<void>((resolve) => window.gapi.load("picker", () => resolve()));
      const { access_token } = await api<{ access_token: string }>(
        "/api/voice/google/access-token",
      );

      const view = new window.google.picker.DocsView(window.google.picker.ViewId.FOLDERS)
        .setSelectFolderEnabled(true)
        .setIncludeFolders(true)
        .setMimeTypes("application/vnd.google-apps.folder");

      const picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(access_token)
        .setDeveloperKey(API_KEY)
        .setCallback((data: any) => {
          if (data.action === window.google.picker.Action.PICKED) {
            const doc = data.docs?.[0];
            if (doc) {
              onPicked({
                id: doc.id,
                name: doc.name ?? doc.id,
                url: doc.url ?? `https://drive.google.com/drive/folders/${doc.id}`,
              });
            }
          }
        })
        .build();
      picker.setVisible(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Google Picker failed to load");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant="outline" onClick={open} disabled={busy}>
      <FolderOpen className="h-4 w-4 me-1" />
      {t("browseDrive")}
    </Button>
  );
}

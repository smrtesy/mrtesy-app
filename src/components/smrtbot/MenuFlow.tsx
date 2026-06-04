"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CornerDownRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api/client";

interface Btn { id?: string; value?: string; title?: string; label?: string }
interface Node {
  id: string;
  node_key: string;
  label: string;
  type: string;
  parent_key: string | null;
  action: string | null;
  buttons: Btn[];
}

/** Read-only visual of the menu tree (parent → child) with each node's buttons
 *  and their targets — the "flow" view botsite's menu editor had. */
export function MenuFlow({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [env, setEnv] = useState<"test" | "live">("live");
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setNodes(null);
    try {
      const { menu } = await api<{ menu: Node[] }>(`/api/bot/${botId}/menu?env=${env}`);
      setNodes(menu);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId, env]);

  useEffect(() => { load(); }, [load]);

  function render(node: Node, all: Node[], depth: number, seen: Set<string>) {
    if (seen.has(node.node_key)) return null; // guard cycles
    seen.add(node.node_key);
    const children = all.filter((n) => n.parent_key === node.node_key);
    return (
      <div key={node.id} style={{ marginInlineStart: depth * 16 }} className="border-s border-border ps-3">
        <div className="flex items-center gap-2 py-1">
          {depth > 0 && <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground" />}
          <span className="font-mono text-xs text-primary" dir="ltr">{node.node_key}</span>
          <span className="text-sm" dir="auto">{node.label}</span>
          {node.action && <span className="rounded bg-accent px-1.5 text-[10px] text-accent-foreground" dir="ltr">{node.action}</span>}
        </div>
        {node.buttons?.length > 0 && (
          <div className="flex flex-wrap gap-1 pb-1 ps-5">
            {node.buttons.map((b, i) => (
              <span key={i} className="rounded-md border border-border bg-muted/40 px-2 py-0.5 text-[11px]" dir="auto">
                {b.title ?? b.label}
                <span className="ms-1 font-mono text-muted-foreground" dir="ltr">→ {b.id ?? b.value}</span>
              </span>
            ))}
          </div>
        )}
        {children.map((ch) => render(ch, all, depth + 1, seen))}
      </div>
    );
  }

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  const roots = (nodes ?? []).filter((n) => !n.parent_key);
  const seen = new Set<string>();

  return (
    <Card>
      <CardContent className="space-y-2 pt-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("menuFlow")}</h2>
          <div className="inline-flex rounded-md border border-border p-0.5">
            {(["test", "live"] as const).map((e) => (
              <button key={e} onClick={() => setEnv(e)}
                className={"rounded px-3 py-1 text-sm " + (env === e ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
                {t(e === "live" ? "envLive" : "envTest")}
              </button>
            ))}
          </div>
        </div>
        {nodes === null ? (
          <p className="text-sm text-muted-foreground">…</p>
        ) : roots.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noItems")}</p>
        ) : (
          <div className="space-y-1">{roots.map((r) => render(r, nodes, 0, seen))}</div>
        )}
      </CardContent>
    </Card>
  );
}

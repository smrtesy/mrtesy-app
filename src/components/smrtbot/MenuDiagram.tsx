"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import dagre from "dagre";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { api } from "@/lib/api/client";

interface Btn { id?: string; value?: string; title?: string; label?: string }
interface MenuNode {
  id: string;
  node_key: string;
  label: string;
  title_he: string | null;
  type: string;
  parent_key: string | null;
  active: boolean;
  buttons: Btn[];
}

const NODE_W = 210;
const NODE_H = 64;

type CardData = { title: string; nodeKey: string; type: string; active: boolean; broken: boolean };

/** A menu node rendered as a card. Handles on both sides so edges flow
 *  right→left (root on the right, RTL). */
function MenuNodeCard({ data }: NodeProps) {
  const d = data as CardData;
  return (
    <div
      className={
        "rounded-lg border bg-card px-3 py-2 text-start shadow-sm " +
        (d.broken ? "border-status-late" : "border-border")
      }
      style={{ width: NODE_W, minHeight: NODE_H }}
    >
      <Handle type="target" position={Position.Right} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1.5">
        <span className="truncate text-sm font-medium" dir="auto">{d.title}</span>
        {!d.active && <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">off</span>}
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="truncate font-mono text-[10px] text-primary" dir="ltr">{d.nodeKey}</span>
        <span className="text-[10px] text-muted-foreground">{d.type}</span>
      </div>
      <Handle type="source" position={Position.Left} style={{ opacity: 0 }} />
    </div>
  );
}

const nodeTypes = { menu: MenuNodeCard };

function layout(menu: MenuNode[]): { nodes: Node[]; edges: Edge[] } {
  const byKey = new Map(menu.map((n) => [n.node_key, n]));
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "RL", nodesep: 28, ranksep: 70, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const n of menu) g.setNode(n.node_key, { width: NODE_W, height: NODE_H });

  const edges: Edge[] = [];
  for (const n of menu) {
    // parent_key hierarchy edge
    if (n.parent_key && byKey.has(n.parent_key)) {
      g.setEdge(n.parent_key, n.node_key);
    }
    // button → target edges (the real navigation graph)
    for (const b of n.buttons ?? []) {
      const target = b.id ?? b.value;
      if (!target) continue;
      const exists = byKey.has(target);
      g.setEdge(n.node_key, exists ? target : `__missing__${target}`);
      if (!exists && !g.hasNode(`__missing__${target}`)) {
        g.setNode(`__missing__${target}`, { width: NODE_W, height: NODE_H });
      }
      edges.push({
        id: `${n.node_key}->${target}`,
        source: n.node_key,
        target: exists ? target : `__missing__${target}`,
        label: b.title ?? b.label,
        animated: !exists,
        style: { stroke: exists ? "#534AB7" : "#D85A30", strokeWidth: 1.5 },
        labelStyle: { fontSize: 10 },
      });
    }
  }

  dagre.layout(g);

  const nodes: Node[] = [];
  for (const key of g.nodes()) {
    const p = g.node(key);
    if (!p) continue;
    const isMissing = key.startsWith("__missing__");
    const src = byKey.get(key);
    nodes.push({
      id: key,
      type: "menu",
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: isMissing
        ? { title: `⚠ ${key.replace("__missing__", "")}`, nodeKey: key.replace("__missing__", ""), type: "missing", active: true, broken: true }
        : { title: src?.title_he || src?.label || key, nodeKey: key, type: src?.type ?? "", active: src?.active ?? true, broken: false },
    });
  }
  return { nodes, edges };
}

export function MenuDiagram({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [env, setEnv] = useState<"test" | "live">("live");
  const [menu, setMenu] = useState<MenuNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMenu(null);
    try {
      const { menu } = await api<{ menu: MenuNode[] }>(`/api/bot/${botId}/menu?env=${env}`);
      setMenu(menu);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId, env]);

  useEffect(() => { load(); }, [load]);

  const { nodes, edges } = useMemo(() => (menu ? layout(menu) : { nodes: [], edges: [] }), [menu]);

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="inline-flex rounded-md border border-border p-0.5">
          {(["test", "live"] as const).map((e) => (
            <button key={e} onClick={() => setEnv(e)}
              className={"rounded px-3 py-1 text-sm " + (env === e ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
              {t(e === "live" ? "envLive" : "envTest")}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted-foreground">{t("menuDiagramHint")}</span>
      </div>
      <div className="h-[70vh] w-full rounded-lg border border-border bg-background">
        {menu === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">…</div>
        ) : nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("noItems")}</div>
        ) : (
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView minZoom={0.2} proOptions={{ hideAttribution: true }}>
            <Background />
            <Controls position="top-left" />
            <MiniMap pannable zoomable />
          </ReactFlow>
        )}
      </div>
    </div>
  );
}

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
import { ChevronLeft, ChevronDown, Pencil } from "lucide-react";

import { api } from "@/lib/api/client";
import { MenuNodeEditDialog } from "./MenuNodeEditDialog";

interface Btn { id?: string; value?: string; title?: string; label?: string }
export interface MenuNode {
  id: string;
  node_key: string;
  label: string;
  title_he: string | null;
  body_text: string | null;
  type: string;
  parent_key: string | null;
  action: string | null;
  image_url: string | null;
  sort_order: number | null;
  active: boolean;
  buttons: Btn[];
}

const NODE_W = 230;
const NODE_H = 68;

type CardData = {
  title: string;
  nodeKey: string;
  type: string;
  active: boolean;
  broken: boolean;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: (key: string) => void;
  onEdit: (key: string) => void;
};

/** A menu node card. Title click → edit; chevron → expand/collapse children. */
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
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1 text-start hover:text-primary"
          onClick={(e) => { e.stopPropagation(); if (!d.broken) d.onEdit(d.nodeKey); }}
          title={d.nodeKey}
        >
          <span className="truncate text-sm font-semibold" dir="auto">{d.title}</span>
          {!d.broken && <Pencil className="h-3 w-3 shrink-0 opacity-0 group-hover:opacity-100" />}
        </button>
        {!d.active && <span className="rounded bg-muted px-1 text-[9px] text-muted-foreground">off</span>}
        {d.hasChildren && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); d.onToggle(d.nodeKey); }}
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            aria-label="expand"
          >
            {d.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
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

function findRootKey(menu: MenuNode[]): string | null {
  const byKey = new Set(menu.map((n) => n.node_key));
  for (const k of ["main", "main_welcome", "main_menu"]) if (byKey.has(k)) return k;
  const parentless = menu.find((n) => !n.parent_key && (n.buttons?.length ?? 0) > 0);
  return parentless?.node_key ?? menu[0]?.node_key ?? null;
}

/** key → child node_keys, from button targets + parent_key relations. */
function buildChildren(menu: MenuNode[]): Map<string, string[]> {
  const byKey = new Map(menu.map((n) => [n.node_key, n]));
  const m = new Map<string, string[]>();
  const add = (parent: string, child: string) => {
    if (parent === child) return;
    const arr = m.get(parent) ?? [];
    if (!arr.includes(child)) arr.push(child);
    m.set(parent, arr);
  };
  for (const n of menu) {
    for (const b of n.buttons ?? []) {
      const tgt = b.id ?? b.value;
      if (tgt && byKey.has(tgt)) add(n.node_key, tgt);
    }
    if (n.parent_key && byKey.has(n.parent_key)) add(n.parent_key, n.node_key);
  }
  return m;
}

function layout(
  menu: MenuNode[],
  rootKey: string,
  expanded: Set<string>,
  children: Map<string, string[]>,
  onToggle: (k: string) => void,
  onEdit: (k: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const byKey = new Map(menu.map((n) => [n.node_key, n]));

  // Visible = root + descendants reachable through expanded nodes.
  const visible = new Set<string>([rootKey]);
  const queue = [rootKey];
  while (queue.length) {
    const k = queue.shift()!;
    if (!expanded.has(k)) continue;
    for (const c of children.get(k) ?? []) {
      if (!visible.has(c)) { visible.add(c); queue.push(c); }
    }
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "RL", nodesep: 28, ranksep: 80, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const k of visible) g.setNode(k, { width: NODE_W, height: NODE_H });

  const edges: Edge[] = [];
  for (const k of visible) {
    if (!expanded.has(k)) continue;
    const n = byKey.get(k);
    for (const b of n?.buttons ?? []) {
      const tgt = b.id ?? b.value;
      if (!tgt) continue;
      const exists = byKey.has(tgt);
      const targetId = exists ? tgt : `__missing__${tgt}`;
      if (!exists) {
        if (!g.hasNode(targetId)) g.setNode(targetId, { width: NODE_W, height: NODE_H });
        visible.add(targetId);
      }
      if (!g.hasNode(targetId)) continue;
      g.setEdge(k, targetId);
      edges.push({
        id: `${k}->${tgt}`,
        source: k,
        target: targetId,
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
    const kids = children.get(key) ?? [];
    nodes.push({
      id: key,
      type: "menu",
      position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 },
      data: isMissing
        ? { title: `⚠ ${key.replace("__missing__", "")}`, nodeKey: key.replace("__missing__", ""), type: "missing", active: true, broken: true, hasChildren: false, expanded: false, onToggle, onEdit }
        : {
            title: src?.title_he || src?.label || key,
            nodeKey: key,
            type: src?.type ?? "",
            active: src?.active ?? true,
            broken: false,
            hasChildren: kids.length > 0,
            expanded: expanded.has(key),
            onToggle,
            onEdit,
          },
    });
  }
  return { nodes, edges };
}

export function MenuDiagram({ botId, env }: { botId: string; env: "test" | "live" }) {
  const t = useTranslations("smrtBot");
  const [menu, setMenu] = useState<MenuNode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editKey, setEditKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setMenu(null);
    setExpanded(new Set()); // start collapsed on every (re)load
    try {
      const { menu } = await api<{ menu: MenuNode[] }>(`/api/bot/${botId}/menu?env=${env}`);
      setMenu(menu);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, [botId, env]);

  useEffect(() => { load(); }, [load]);

  const onToggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const onEdit = useCallback((key: string) => setEditKey(key), []);

  const rootKey = useMemo(() => (menu ? findRootKey(menu) : null), [menu]);
  const children = useMemo(() => (menu ? buildChildren(menu) : new Map<string, string[]>()), [menu]);

  const { nodes, edges } = useMemo(
    () => (menu && rootKey ? layout(menu, rootKey, expanded, children, onToggle, onEdit) : { nodes: [], edges: [] }),
    [menu, rootKey, expanded, children, onToggle, onEdit],
  );

  const editingNode = useMemo(
    () => (editKey && menu ? menu.find((n) => n.node_key === editKey) ?? null : null),
    [editKey, menu],
  );

  if (error) return <p className="text-sm text-destructive">{error}</p>;

  return (
    <div className="space-y-2">
      <p className="text-center text-xs text-muted-foreground">{t("menuDiagramHint")}</p>
      <div className="h-[72vh] w-full rounded-lg border border-border bg-background">
        {menu === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">…</div>
        ) : nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t("noItems")}</div>
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            fitViewOptions={{ maxZoom: 1, minZoom: 0.4, padding: 0.4 }}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls position="top-left" showInteractive={false} />
            <MiniMap pannable zoomable />
          </ReactFlow>
        )}
      </div>

      {editingNode && (
        <MenuNodeEditDialog
          botId={botId}
          node={editingNode}
          onClose={() => setEditKey(null)}
          onSaved={() => { setEditKey(null); void load(); }}
        />
      )}
    </div>
  );
}

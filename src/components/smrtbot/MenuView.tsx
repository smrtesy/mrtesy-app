"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { ResourceManager } from "./ResourceManager";
import { RESOURCES } from "./resourceConfigs";

// reactflow is client-only — load the diagram without SSR.
const MenuDiagram = dynamic(() => import("./MenuDiagram").then((m) => m.MenuDiagram), {
  ssr: false,
  loading: () => <p className="text-sm text-muted-foreground">…</p>,
});

/** Menu management: graphical flow diagram (default) + table editor toggle. */
export function MenuView({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [view, setView] = useState<"diagram" | "table">("diagram");

  return (
    <div className="space-y-3">
      <div className="inline-flex rounded-md border border-border p-0.5">
        <button
          onClick={() => setView("diagram")}
          className={"rounded px-3 py-1 text-sm " + (view === "diagram" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
        >
          {t("viewDiagram")}
        </button>
        <button
          onClick={() => setView("table")}
          className={"rounded px-3 py-1 text-sm " + (view === "table" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
        >
          {t("viewTable")}
        </button>
      </div>
      {view === "diagram" ? <MenuDiagram botId={botId} /> : <ResourceManager botId={botId} config={RESOURCES.menu} />}
    </div>
  );
}

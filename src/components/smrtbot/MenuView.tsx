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

/** Menu management: graphical flow diagram (default) + table editor toggle.
 *  One centered toolbar row holds the view toggle and (for the diagram) the
 *  test/live switch. */
export function MenuView({ botId }: { botId: string }) {
  const t = useTranslations("smrtBot");
  const [view, setView] = useState<"diagram" | "table">("diagram");
  const [env, setEnv] = useState<"test" | "live">("live");

  const seg = (active: boolean) =>
    "rounded px-3 py-1 text-sm " + (active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <div className="inline-flex rounded-md border border-border p-0.5">
          <button onClick={() => setView("diagram")} className={seg(view === "diagram")}>{t("viewDiagram")}</button>
          <button onClick={() => setView("table")} className={seg(view === "table")}>{t("viewTable")}</button>
        </div>
        {view === "diagram" && (
          <div className="inline-flex rounded-md border border-border p-0.5">
            {(["test", "live"] as const).map((e) => (
              <button key={e} onClick={() => setEnv(e)} className={seg(env === e)}>
                {t(e === "live" ? "envLive" : "envTest")}
              </button>
            ))}
          </div>
        )}
      </div>

      {view === "diagram" ? (
        <MenuDiagram botId={botId} env={env} />
      ) : (
        <ResourceManager botId={botId} config={RESOURCES.menu} />
      )}
    </div>
  );
}

"use client";

/**
 * The investor page — always English, whatever the app locale is.
 *
 * The audience reads English, so this screen pins `locale = "en"` for every
 * bilingual field it renders rather than following the UI language. That is
 * deliberate and is the one place in the app where the content language is
 * decoupled from the interface language.
 *
 * Two tiers: the headline claim on top, and the pipeline plus the ledger
 * underneath. Everything is the same live data the operator sees — the
 * investor view is a different framing of one source, never a second set of
 * numbers.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

import { api } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

import { StudioPipeline } from "./StudioPipeline";
import type { InvestmentResponse, Overview, ResearchResponse } from "./types";

const EN = "en";

function money(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function StudioInvestor() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [research, setResearch] = useState<ResearchResponse | null>(null);
  const [investment, setInvestment] = useState<InvestmentResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [o, r, i] = await Promise.all([
        api<Overview>("/api/studio/overview"),
        api<ResearchResponse>("/api/studio/research"),
        api<InvestmentResponse>("/api/studio/investment"),
      ]);
      setOverview(o);
      setResearch(r);
      setInvestment(i);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !overview) return <Skeleton className="h-96 w-full" />;

  if (error) {
    return (
      <div dir="ltr" className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-start">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <AlertTriangle className="h-4 w-4" />
          Could not load the program data
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{error}</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => void load()}>
          <RefreshCw className="me-1.5 h-3.5 w-3.5" />
          Retry
        </Button>
      </div>
    );
  }

  if (!overview) return null;

  const { totals } = overview;
  // The ask lives in the ledger, not in this file: it is org-scoped data, so a
  // second tenant never inherits this tenant's funding request, and it can only
  // change by an explicit recorded edit.
  const ledger = investment?.items ?? [];
  const workRows = ledger.filter((r) => r.kind === "work" || r.kind === "direct");
  const askTotal = ledger.find((r) => r.kind === "ask_total")?.value_usd ?? null;
  const tranches = ledger.filter((r) => r.kind === "ask");
  const motion = overview.stages.find((s) => s.slug === "motion");
  const motionUnproven = (motion?.outputs ?? 0) === 0;

  return (
    <div dir="ltr" className="grid gap-5 text-start">
      <header className="grid gap-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">
          AI Video Platform · Program status
        </p>
        <h1 className="text-3xl font-semibold leading-tight">
          A studio that produces children&apos;s drama episodes with AI
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
          A weekly 10–12 minute episode, characters that look the same in every episode, in Hebrew
          and English — and further languages from the same production. A working lab is
          establishing which tool can hold that standard; the system that will run it at a weekly
          cadence is being built.
        </p>
      </header>

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {[
          { v: String(totals.runs), l: "Outputs produced and recorded" },
          { v: String(research?.total ?? 0), l: "Research artifacts on the shelf" },
          { v: `${totals.stages_locked}/${totals.stages_total}`, l: "Pipeline stages settled" },
          { v: `$${totals.recorded_cost_usd.toFixed(2)}`, l: "Direct AI spend recorded" },
        ].map((k) => (
          <div key={k.l} className="rounded-xl border bg-card px-3 py-3">
            <p className="text-2xl font-semibold tabular-nums leading-none">{k.v}</p>
            <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">{k.l}</p>
          </div>
        ))}
      </section>

      {motionUnproven && (
        <p className="rounded-lg border-s-[3px] border-primary bg-secondary/45 px-3 py-2.5 text-xs leading-relaxed">
          <b>Stated plainly:</b> motion generation — the stage that turns frames into clips, and the
          one the memo calls the real engine — has not been run yet. Zero outputs. Everything on
          this page that concerns motion is research, not measurement.
        </p>
      )}

      <section className="rounded-xl border bg-card">
        <header className="border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">The pipeline — ten stages, and what each has passed</h2>
          <p className="text-[11px] text-muted-foreground">
            Select a stage to see its gates, the difficulties expected and actually hit, the
            research behind it, and its outputs.
          </p>
        </header>
        <div className="p-3">
          <StudioPipeline
            stages={overview.stages}
            research={research?.items ?? []}
            locale={EN}
          />
        </div>
      </section>

      {investment && (
        <section className="rounded-xl border bg-card">
          <header className="border-b px-3 py-2.5">
            <h2 className="text-sm font-semibold">What has been invested</h2>
          </header>
          <div className="grid gap-3 p-3 lg:grid-cols-[220px_1fr]">
            <div className="rounded-xl border bg-secondary/35 px-3 py-3">
              <p className="text-2xl font-semibold tabular-nums leading-none">
                {money(investment.total_work_usd)}
              </p>
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Value of work invested ·{" "}
                {investment.total_hours.toLocaleString("en-US")} hours
              </p>
              {askTotal != null && (
                <div className="mt-3 border-t pt-2.5">
                  <p className="text-xl font-semibold tabular-nums leading-none">
                    {money(askTotal)}
                  </p>
                  <p className="mt-1 text-[11.5px] text-muted-foreground">Full program</p>
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead className="bg-secondary/55 text-[10.5px] uppercase tracking-wide">
                  <tr>
                    <th className="px-3 py-2 text-start font-semibold">Type of work</th>
                    <th className="px-3 py-2 text-start font-semibold">Hours</th>
                    <th className="px-3 py-2 text-start font-semibold">Value</th>
                    <th className="px-3 py-2 text-start font-semibold">What it covers</th>
                  </tr>
                </thead>
                <tbody>
                  {workRows.map((row) => (
                    <tr key={row.id} className="border-t align-top">
                      <td className="px-3 py-2 font-semibold">{row.label_en}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {row.hours != null ? row.hours.toLocaleString("en-US") : "—"}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        ${row.value_usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{row.detail_en}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {tranches.length > 0 && (
        <section className="rounded-xl border bg-card">
          <header className="border-b px-3 py-2.5">
            <h2 className="text-sm font-semibold">
              The ask{askTotal != null ? ` — ${money(askTotal)}` : ""}
            </h2>
          </header>
          <div className="grid gap-2 p-3 sm:grid-cols-3">
            {tranches.map((tr) => (
              <div key={tr.id} className="rounded-xl border px-3 py-3">
                <p className="text-xl font-semibold tabular-nums leading-none">
                  {money(tr.value_usd)}
                </p>
                <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-primary">
                  {tr.label_en}
                </p>
                <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                  {tr.detail_en}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border bg-card">
        <header className="border-b px-3 py-2.5">
          <h2 className="text-sm font-semibold">Built to stay current</h2>
        </header>
        <ul className="grid gap-2 p-3 text-xs leading-relaxed text-muted-foreground sm:grid-cols-2">
          <li>
            <b className="text-foreground">The catalog is re-scanned, not memorized.</b> A new model
            enters the ranked lists without touching the pipeline. There is no lock-in to one vendor.
          </li>
          <li>
            <b className="text-foreground">Every capability is verified against the official spec</b>{" "}
            before it is relied on — marketing copy never decides how we call an API.
          </li>
          <li>
            <b className="text-foreground">Every decision is reproducible</b> — who decided, when,
            and on which data. Rejected outputs are kept, never deleted.
          </li>
          <li>
            <b className="text-foreground">Bilingual to the foundation,</b> structured so a third
            language is an addition rather than a rebuild.
          </li>
        </ul>
      </section>

      <footer className="text-[10.5px] leading-relaxed text-muted-foreground">
        Output counts, costs and scores on this page are read live from the production database.
        Hours and program value are figures supplied by the owner. The ask and its tranches are a
        stated position, not measured data.
      </footer>
    </div>
  );
}

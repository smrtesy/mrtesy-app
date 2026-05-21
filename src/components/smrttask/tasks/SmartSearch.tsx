"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Task } from "@/types/task";

interface SmartSearchProps {
  onResults: (tasks: Task[]) => void;
}

// Sanitize input for PostgREST filter expressions
function sanitizeFilter(value: string): string {
  // Remove characters that could manipulate PostgREST filters
  return value.replace(/[%(),.*\\]/g, "").trim();
}

export function SmartSearch({ onResults }: SmartSearchProps) {
  const t = useTranslations("tasks.search");
  const [query, setQuery] = useState("");
  const [includeArchive, setIncludeArchive] = useState(false);
  const supabase = createClient();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  function handleChange(value: string) {
    setQuery(value);

    // Debounce 300ms
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => handleSearch(value), 300);
  }

  async function handleSearch(value: string) {
    const sanitized = sanitizeFilter(value);
    if (sanitized.length < 2) {
      onResults([]);
      return;
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Use individual .ilike() calls combined manually instead of .or() with string interpolation
    const baseQuery = () => {
      let q = supabase
        .from("tasks")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(40);

      if (!includeArchive) {
        q = q.neq("status", "archived");
      }
      return q;
    };

    // 1) Task serial — exact match on "T<n>" / "t<n>"
    const taskMatch = sanitized.match(/^[Tt](\d+)$/);
    if (taskMatch) {
      const { data } = await baseQuery().eq("serial_display", `T${taskMatch[1]}`);
      onResults((data ?? []) as Task[]);
      return;
    }

    // 2) Source-message serial — match "G<n>", "S<n>", "W<n>", "E<n>", "D<n>", "C<n>".
    // Look up the source_message first, then return tasks linked to it.
    const srcMatch = sanitized.match(/^([GSWEDCgswedc])(\d+)$/);
    if (srcMatch) {
      const display = `${srcMatch[1].toUpperCase()}${srcMatch[2]}`;
      const { data: srcRows } = await supabase
        .from("source_messages")
        .select("id")
        .eq("user_id", user.id)
        .eq("serial_display", display)
        .limit(1);
      const srcIds = (srcRows ?? []).map((r: { id: string }) => r.id);
      if (srcIds.length === 0) {
        onResults([]);
        return;
      }
      const { data } = await baseQuery().in("source_message_id", srcIds);
      onResults((data ?? []) as Task[]);
      return;
    }

    // 3) Free-text search across title / title_he / description (existing).
    const term = `%${sanitized}%`;
    const { data } = await baseQuery()
      .or(`title.ilike.${term},title_he.ilike.${term},description.ilike.${term}`);

    onResults((data ?? []) as Task[]);
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          placeholder={t("placeholder")}
          className="ps-10 min-h-[48px] text-start"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={includeArchive}
          onChange={(e) => setIncludeArchive(e.target.checked)}
        />
        {t("includeArchive")}
      </label>
    </div>
  );
}

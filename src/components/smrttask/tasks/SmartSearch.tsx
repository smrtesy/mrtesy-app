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
        .limit(20);

      if (!includeArchive) {
        q = q.neq("status", "archived");
      }
      return q;
    };

    // Run 3 parallel searches on different columns
    const [titleHeResult, descResult, titleResult] = await Promise.all([
      baseQuery().ilike("title_he", `%${sanitized}%`),
      baseQuery().ilike("description", `%${sanitized}%`),
      baseQuery().ilike("title", `%${sanitized}%`),
    ]);

    // Merge and deduplicate results
    const allResults = [
      ...(titleHeResult.data || []),
      ...(descResult.data || []),
      ...(titleResult.data || []),
    ];
    const seen = new Set<string>();
    const unique = allResults.filter((task) => {
      if (seen.has(task.id)) return false;
      seen.add(task.id);
      return true;
    });

    onResults(unique as Task[]);
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

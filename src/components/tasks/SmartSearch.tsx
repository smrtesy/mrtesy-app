"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

interface SmartSearchProps {
  onResults: (tasks: unknown[]) => void;
}

export function SmartSearch({ onResults }: SmartSearchProps) {
  const t = useTranslations("tasks.search");
  const [query, setQuery] = useState("");
  const [includeArchive, setIncludeArchive] = useState(false);
  const supabase = createClient();

  async function handleSearch(value: string) {
    setQuery(value);
    if (value.length < 2) {
      onResults([]);
      return;
    }

    // Debounce handled by caller or useEffect
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    let qb = supabase
      .from("tasks")
      .select("*")
      .eq("user_id", user.id)
      .or(`title_he.ilike.%${value}%,description.ilike.%${value}%,title.ilike.%${value}%`)
      .order("created_at", { ascending: false })
      .limit(20);

    if (!includeArchive) {
      qb = qb.neq("status", "archived");
    }

    const { data } = await qb;
    onResults(data || []);
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t("placeholder")}
          className="ps-10 min-h-[48px]"
          dir="auto"
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

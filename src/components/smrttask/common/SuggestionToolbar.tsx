"use client";

import { useTranslations } from "next-intl";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CheckCircle2, X, Search, XCircle } from "lucide-react";

interface SuggestionToolbarProps {
  total: number;
  filtered: number;
  selectedCount: number;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulkApprove?: () => void;
  onBulkDismissFast?: () => void;
  onBulkDismissWithReason?: () => void;
}

export function SuggestionToolbar({
  total,
  filtered,
  selectedCount,
  searchQuery,
  onSearchChange,
  onSelectAll,
  onClearSelection,
  onBulkApprove,
  onBulkDismissFast,
  onBulkDismissWithReason,
}: SuggestionToolbarProps) {
  const t = useTranslations("suggestions");

  return (
    <div className="space-y-2 pb-1">
      {/* Search input */}
      <div className="relative">
        <Search className="absolute top-1/2 -translate-y-1/2 start-2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("searchPlaceholder")}
          className="ps-8 pe-8 min-h-[40px]"
          dir="auto"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => onSearchChange("")}
            className="absolute top-1/2 -translate-y-1/2 end-2 text-muted-foreground hover:text-foreground"
            aria-label={t("clearSelection")}
          >
            <XCircle className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Count + select-all row */}
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">
          {searchQuery
            ? t("countLabel", { shown: filtered, total })
            : t("countLabel", { shown: total, total })}
        </span>
        {filtered > 0 && (
          <button
            type="button"
            onClick={selectedCount === filtered ? onClearSelection : onSelectAll}
            className="text-primary underline-offset-2 hover:underline"
          >
            {selectedCount === filtered ? t("clearSelection") : t("selectAll")}
          </button>
        )}
      </div>

      {/* Bulk-action row — only visible when something is selected. */}
      {selectedCount > 0 && (
        <div className="flex items-center gap-2 flex-wrap rounded-md border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">
            {t("selectedCount", { count: selectedCount })}
          </span>
          <div className="flex-1" />
          {onBulkApprove && (
            <Button
              size="sm"
              className="h-9 gap-1"
              onClick={onBulkApprove}
            >
              <CheckCircle2 className="h-4 w-4" />
              {t("bulkApprove")}
            </Button>
          )}
          {onBulkDismissFast && (
            <Button
              size="sm"
              variant="ghost"
              className="h-9 gap-1 text-muted-foreground hover:text-foreground"
              onClick={onBulkDismissFast}
            >
              <X className="h-4 w-4" />
              {t("bulkDismiss")}
            </Button>
          )}
          {onBulkDismissWithReason && (
            <Button
              size="sm"
              variant="ghost"
              className="h-9 gap-1 text-red-500 hover:text-red-600"
              onClick={onBulkDismissWithReason}
            >
              <X className="h-4 w-4" />
              {t("bulkDismissWithReason")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

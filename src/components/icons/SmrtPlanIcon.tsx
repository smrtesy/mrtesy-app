import { cn } from "@/lib/utils";

/** smrtPlan — a Gantt/timeline glyph: stacked schedule bars. */
export function SmrtPlanIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <rect x="3" y="5" width="11" height="3.2" rx="1.4" fill="currentColor" opacity="0.9" />
      <rect x="7" y="10.4" width="11" height="3.2" rx="1.4" fill="currentColor" opacity="0.6" />
      <rect x="5" y="15.8" width="8" height="3.2" rx="1.4" fill="currentColor" opacity="0.9" />
    </svg>
  );
}

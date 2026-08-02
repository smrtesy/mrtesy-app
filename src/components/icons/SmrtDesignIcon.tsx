import { cn } from "@/lib/utils";

/** smrtDesign — three overlapping colour swatches: distinct design directions. */
export function SmrtDesignIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <rect x="3" y="6" width="10" height="12" rx="2" fill="currentColor" opacity="0.9" />
      <rect x="8" y="4.5" width="10" height="12" rx="2" fill="currentColor" opacity="0.55" />
      <circle cx="17" cy="16" r="4" fill="currentColor" opacity="0.35" />
    </svg>
  );
}

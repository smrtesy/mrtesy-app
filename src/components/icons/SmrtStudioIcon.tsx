import { cn } from "@/lib/utils";

/** smrtStudio — a clapperboard glyph: the slate over a filmstrip frame. */
export function SmrtStudioIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <rect x="3" y="4" width="18" height="4.4" rx="1.3" fill="currentColor" opacity="0.9" />
      <path d="M7.6 4 5.9 8.4M12.4 4l-1.7 4.4M17.2 4l-1.7 4.4" stroke="#fff" strokeWidth="1.2" />
      <rect x="3" y="10" width="18" height="10" rx="1.8" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="15" r="2.4" fill="#fff" opacity="0.9" />
    </svg>
  );
}

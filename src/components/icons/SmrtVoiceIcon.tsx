import { cn } from "@/lib/utils";

export function SmrtVoiceIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <path d="M5 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.5 7v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M12 4v16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M15.5 7v10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M19 10v4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

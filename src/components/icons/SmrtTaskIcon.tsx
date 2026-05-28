import { cn } from "@/lib/utils";

export function SmrtTaskIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("h-5 w-5", className)}
    >
      <rect
        x="3.5"
        y="3.5"
        width="17"
        height="17"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M7.5 12.5 L10.7 15.7 L16.8 8.6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="18.5" cy="5.5" r="1.6" fill="currentColor" />
    </svg>
  );
}

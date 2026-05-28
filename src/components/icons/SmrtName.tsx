import { cn } from "@/lib/utils";

interface Props {
  /** Second word (e.g. "Task", "Voice", "CRM"). Rendered with a normal capital. */
  word: string;
  className?: string;
}

export function SmrtName({ word, className }: Props) {
  const head = word.charAt(0).toUpperCase();
  const tail = word.slice(1);
  return (
    <span className={cn("font-semibold tracking-tight whitespace-nowrap", className)} dir="ltr">
      <span className="lowercase">smrt</span>
      <span>{head}</span>
      <span>{tail}</span>
    </span>
  );
}

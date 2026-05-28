import { cn } from "@/lib/utils";

interface Props {
  /** Second word (e.g. "Task", "Voice", "CRM"). First letter rendered large. */
  word: string;
  className?: string;
  /** Override the highlight size for the first letter. Default scales gently. */
  emphasisClassName?: string;
}

export function SmrtName({ word, className, emphasisClassName }: Props) {
  const head = word.charAt(0);
  const tail = word.slice(1);
  return (
    <span className={cn("font-semibold tracking-tight whitespace-nowrap", className)} dir="ltr">
      <span className="lowercase">smrt</span>
      <span className={cn("text-[1.25em] font-bold leading-none", emphasisClassName)}>{head}</span>
      <span>{tail}</span>
    </span>
  );
}

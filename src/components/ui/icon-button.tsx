"use client";

import * as React from "react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Unified icon-button for the whole system (smrtesy design system §5).
 *
 * Principle: the row is quiet at rest (every icon the same neutral gray),
 * and interaction reveals identity (a per-icon color) and meaning (a
 * mandatory tooltip). There is exactly ONE icon-button component — do not
 * fork variants. Pick a `color` per the icon's identity:
 *   chat → blue · docs → green · dismiss → violet · today → amber ·
 *   history → primary (purple) · delete → red · status → ok/warn/late.
 *
 * At rest: muted-foreground, transparent bg, 36px (mobile) / 32px (desktop),
 * rounded-md. On hover: the identity color + a faint matching background.
 */
const iconButtonColors = {
  neutral: "hover:text-foreground hover:bg-accent",
  primary: "hover:text-primary hover:bg-primary/10",
  blue: "hover:text-blue-600 hover:bg-blue-500/10",
  green: "hover:text-status-ok hover:bg-status-ok/10",
  amber: "hover:text-status-warn hover:bg-status-warn/10",
  red: "hover:text-status-late hover:bg-status-late/10",
  violet: "hover:text-violet-600 hover:bg-violet-500/10",
  cyan: "hover:text-cyan-600 hover:bg-cyan-500/10",
} as const;

export type IconButtonColor = keyof typeof iconButtonColors;

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Tooltip text + accessible label. Mandatory — no naked action icons. */
  label: string;
  /** Hover identity color. Defaults to neutral. */
  color?: IconButtonColor;
  /** Tooltip side. */
  side?: "top" | "bottom" | "left" | "right";
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, color = "neutral", side = "top", className, children, ...props }, ref) => (
    <TooltipProvider delayDuration={300} disableHoverableContent>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            aria-label={label}
            title={label}
            className={cn(
              "inline-flex items-center justify-center rounded-md bg-transparent text-muted-foreground transition-colors",
              "h-9 w-9 md:h-8 md:w-8",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
              iconButtonColors[color],
              className,
            )}
            {...props}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ),
);
IconButton.displayName = "IconButton";

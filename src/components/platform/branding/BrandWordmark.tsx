import { cn } from "@/lib/utils";

/**
 * The smrtesy wordmark lockup: the "smrtesy" name with a small, strong-orange
 * "by Maor" tagline beneath it. The tagline is regular weight, right-aligned
 * to the name and lightly tracked so it begins just after the "m" and ends
 * beside the "y" (level with the end of the second "s").
 *
 * Everything is sized in `em`, so the whole lockup scales with the
 * font-size set on the wrapping element (e.g. `text-4xl` on login,
 * `text-xl` in the sidebar). `dir="ltr"` keeps the Latin lockup laid out
 * left-to-right even inside the app's RTL (Hebrew) pages. The name's color
 * is inherited from the parent (matching the previous plain-text wordmark);
 * the tagline sets its own orange.
 */
export function BrandWordmark({
  className,
  taglineStyle,
}: {
  className?: string;
  /**
   * Optional per-instance overrides for the "by Maor" line. Used by the
   * sidebar to enlarge the tagline; when the font-size changes, the tracking
   * and end-padding (both in tagline `em`) are re-tuned here too so the line
   * still starts after "m" and ends beside "y".
   */
  taglineStyle?: React.CSSProperties;
}) {
  return (
    <span
      dir="ltr"
      className={cn("inline-flex flex-col items-stretch leading-none", className)}
    >
      <span className="font-bold">smrtesy</span>
      <span
        className="font-normal"
        style={{
          fontSize: "0.34em",
          color: "#f97316",
          // Right-align within the name's width; the end-padding stops the
          // line beside the "y" and the tracking spreads it back past "m".
          textAlign: "right",
          letterSpacing: "0.26em",
          paddingInlineEnd: "2em",
          marginTop: "0.14em",
          whiteSpace: "nowrap",
          ...taglineStyle,
        }}
      >
        by Maor
      </span>
    </span>
  );
}

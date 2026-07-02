import type { Config } from "tailwindcss";
import tailwindAnimate from "tailwindcss-animate";
import plugin from "tailwindcss/plugin";
import defaultTheme from "tailwindcss/defaultTheme";

const config: Config = {
  darkMode: ["class"],
  // Gate every `hover:` utility behind `@media (hover: hover)`. Without this,
  // Tailwind emits a bare `:hover` selector that touch browsers apply with
  // "sticky hover": the FIRST tap on a hover-styled control (every IconButton
  // carries `hover:` classes) only applies the hover state and is swallowed,
  // so the click needs a second tap to register. Confining hover styles to
  // real pointer devices removes the swallowed first tap on phones/tablets.
  future: {
    hoverOnlyWhenSupported: true,
  },
  content: [
    "./src/pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        // גופן המערכת — Heebo (נטען ב-layout דרך next/font), עם נפילה למערכת
        sans: ["var(--font-heebo)", ...defaultTheme.fontFamily.sans],
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        // סטטוסים סמנטיים — שימוש: טקסט בצבע המלא, רקע בגוון ה-bg
        status: {
          ok: "hsl(var(--status-ok))",
          "ok-bg": "hsl(var(--status-ok-bg))",
          warn: "hsl(var(--status-warn))",
          "warn-bg": "hsl(var(--status-warn-bg))",
          late: "hsl(var(--status-late))",
          "late-bg": "hsl(var(--status-late-bg))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [
    tailwindAnimate,
    // `touch:` — applies only on devices without a real hover pointer
    // (phones/tablets). Pairs with `hoverOnlyWhenSupported`: controls that
    // are revealed via `group-hover:` on the desktop stay reachable on touch
    // with `touch:opacity-100` instead of being permanently invisible.
    plugin(({ addVariant }) => {
      addVariant("touch", "@media (hover: none)");
    }),
  ],
};
export default config;

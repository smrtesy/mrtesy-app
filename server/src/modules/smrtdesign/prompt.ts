/**
 * smrtDesign — the method-primed prompts sent to the built-in Claude engine.
 *
 * The engine runs inside a clone of this repo (repo="smrtesy/mrtesy-app"), so
 * docs/design-process.md loads and IS the method. These builders don't restate
 * the method — they point the engine at it and pin the deliverable contract
 * (rendered screenshots + a per-option JSON spec) that routes.ts ingests.
 *
 * Pure string builders — no DB / schema dependencies.
 */

export const DIMENSIONS = [
  "typography",
  "color",
  "neutral",
  "layout",
  "motion",
  "signature",
  "voice",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface GenerationInput {
  subject: string;
  audience?: string | null;
  languages: string[]; // e.g. ["he"], ["he","en"]
  optionCount: number;
}

const langLabel = (langs: string[]): string => {
  const set = new Set(langs);
  if (set.has("he") && set.has("en")) return "Hebrew + English (bilingual, RTL-aware)";
  if (set.has("he")) return "Hebrew (RTL)";
  if (set.has("en")) return "English";
  return langs.join(", ");
};

/**
 * The per-option deliverable contract. Every generated/remixed option must post
 * a screenshot AND emit this exact fenced block so routes.ts can parse the spec
 * for the gallery and the pick-from-each remix.
 */
export const OPTION_BLOCK_SPEC = `
For EACH option, after rendering and screenshotting it, output ONE fenced block
tagged \`smrtdesign-option\` containing a JSON object with these exact keys:
{
  "anchor":     "the subject-specific anchor this option was derived from (§0 step 2)",
  "title":      "a short human label for this option",
  "typography": "the type decision (faces, weights, scale)",
  "color":      "dominant + accent + how used",
  "neutral":    "the chosen neutral and its hue bias",
  "layout":     "the information-architecture / composition idea (NOT just a skin)",
  "motion":     "the one orchestrated moment, or 'none'",
  "signature":  "the single memorable identifying element",
  "voice":      "the copy tone"
}
The screenshot for that option must be posted immediately before its block.`;

export function buildGenerationPrompt(input: GenerationInput): string {
  const { subject, audience, languages, optionCount } = input;
  return [
    `You are running smrtDesign. Follow the design method in docs/design-process.md`,
    `EXACTLY — run §0 (the generative engine): derive every decision from a`,
    `subject-specific ANCHOR, pass the anti-AI gate (§3), and apply the`,
    `divergence test (§0 step 6). Do NOT produce the generic AI look.`,
    ``,
    `Subject: ${subject}`,
    audience ? `Audience: ${audience}` : `Audience: (infer from the subject)`,
    `Languages: ${langLabel(languages)}`,
    ``,
    `Produce ${optionCount} DISTINCT options, each derived from a DIFFERENT anchor,`,
    `so they differ in information-architecture/layout — not just fonts and colors`,
    `("same skeleton reskinned" is not variety). No 01/02/03 numbered-steps cliche.`,
    `Real, professional typography (inline @font-face for any non-system face).`,
    ``,
    `For each option: write a self-contained HTML file, render it in a browser,`,
    `screenshot it with the browser helper, and post the screenshot. Verify each`,
    `render with your own eyes (§0 step 8) and fix any layout/bidi/contrast defect`,
    `BEFORE posting. Then emit the option block.`,
    OPTION_BLOCK_SPEC,
  ].join("\n");
}

/**
 * The opening turn of an INTERACTIVE design conversation (v2, mode='conversation').
 * Unlike buildGenerationPrompt (which renders immediately), this seeds a chat: the
 * engine greets, restates the brief, and refines it WITH the user before rendering.
 * The callback (POST each render) is appended by routes.ts, same as the auto path.
 */
export function buildOpenConversationPrompt(input: GenerationInput): string {
  const { subject, audience, languages, optionCount } = input;
  return [
    `You are running smrtDesign in INTERACTIVE mode — a design conversation with`,
    `the user, who is NOT a designer. Follow the design method in`,
    `docs/design-process.md (§0 the generative engine, §3 the anti-AI gate).`,
    ``,
    `The brief so far:`,
    `- Subject: ${subject}`,
    audience ? `- Audience: ${audience}` : `- Audience: (not given — ask, or infer)`,
    `- Languages: ${langLabel(languages)}`,
    `- Wants about ${optionCount} distinct directions.`,
    ``,
    `Your FIRST reply: greet briefly in Hebrew, restate the brief in one line, and`,
    `ask 2–4 sharp clarifying questions that will most change the design (purpose,`,
    `feeling/tone, must-haves, what it must NOT look like). Prefer an interactive`,
    `\`smrtdesign-ask\`… actually use the console's own ask block if available; else`,
    `plain numbered questions. DO NOT render or screenshot anything yet.`,
    ``,
    `Only once the brief is clear — or the user says "קדימה"/"go"/"just design it" —`,
    `produce the distinct options: each from a DIFFERENT anchor (differ in`,
    `information-architecture/layout, not just fonts/colors), pass the anti-AI gate,`,
    `no 01/02/03 cliche, real professional typography (inline @font-face). For each`,
    `option: self-contained HTML → render in a browser → screenshot with the browser`,
    `helper → verify with your own eyes (§0 step 8) and fix defects → post it.`,
    OPTION_BLOCK_SPEC,
  ].join("\n");
}

/**
 * The turn posted when LINKING an existing conversation to a design project (v2,
 * option A). It tells the engine that, from now on, every design it renders in this
 * thread should be posted to the project's gallery. The callback is appended by
 * routes.ts.
 */
export function buildLinkThreadPrompt(): string {
  return [
    `This conversation is now linked to a smrtDesign project. From now on, whenever`,
    `you render a design here (HTML → browser → screenshot), ALSO post it to the`,
    `smrtDesign gallery so it appears for review and remixing — using the curl below,`,
    `one POST per rendered option, with the \`smrtdesign-option\` JSON block. You do`,
    `not need to re-render past designs; apply this to new renders from here on.`,
    OPTION_BLOCK_SPEC,
  ].join("\n");
}

export interface RemixInput {
  /** dimension -> the anchor/title of the source option to take it from */
  picks: Partial<Record<Dimension, string>>;
  /** the full spec_json of each source option, keyed by a stable label */
  sources: Record<string, Record<string, unknown>>;
}

export function buildRemixPrompt(input: RemixInput): string {
  const pickLines = DIMENSIONS.map((d) =>
    input.picks[d] ? `- ${d}: take from "${input.picks[d]}"` : `- ${d}: designer's choice (derive from the anchor)`,
  ).join("\n");
  return [
    `You are running a smrtDesign REMIX. Compose ONE combined design by taking`,
    `each of the 7 dimensions from the chosen source option below, then RENDER it`,
    `(HTML → browser → screenshot → post). This is an explicit spec, not a guess.`,
    ``,
    `Take each dimension from:`,
    pickLines,
    ``,
    `Source specs (JSON):`,
    "```json",
    JSON.stringify(input.sources, null, 2),
    "```",
    ``,
    `Run the divergence test (§0 step 6): if the combination reads generic or`,
    `incoherent, adjust toward the dominant anchor and say what you changed.`,
    `Verify the render with your own eyes and fix defects before posting.`,
    `Then emit ONE \`smrtdesign-option\` block for the combined design`,
    `(same JSON keys), with "is_combined" understood.`,
    OPTION_BLOCK_SPEC,
  ].join("\n");
}

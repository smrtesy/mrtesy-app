export const dynamic = "force-dynamic";

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { DocsBrowser } from "@/components/admin/DocsBrowser";
import docsMeta from "@/generated/docs-meta.json";

type DocMeta = { created: string | null; updated: string | null };

export default function AdminDocsPage() {
  const dir = join(process.cwd(), "docs");
  const meta = docsMeta as Record<string, DocMeta>;
  let docs: { filename: string; content: string; created: string | null; updated: string | null }[] = [];
  try {
    docs = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((filename) => ({
        filename,
        content: readFileSync(join(dir, filename), "utf-8"),
        created: meta[filename]?.created ?? null,
        updated: meta[filename]?.updated ?? null,
      }));
  } catch { /* docs dir may be absent in some build environments */ }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">מסמכים</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          תיעוד פנימי — {docs.length} מסמכים ב-docs/
        </p>
      </div>
      <DocsBrowser docs={docs} />
    </div>
  );
}

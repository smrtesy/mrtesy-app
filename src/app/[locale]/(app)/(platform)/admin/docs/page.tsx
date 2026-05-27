export const dynamic = "force-dynamic";

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { DocsBrowser } from "@/components/admin/DocsBrowser";

export default function AdminDocsPage() {
  const dir = join(process.cwd(), "docs");
  let docs: { filename: string; content: string }[] = [];
  try {
    docs = readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((filename) => ({ filename, content: readFileSync(join(dir, filename), "utf-8") }));
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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Facebook setup guide" };

/**
 * Renders docs/meta-lead-ads.md: headings (optionally `{#anchor}`), numbered/bulleted lists, tables, links, `code`,
 * **bold** and *italic* only. Lines between `<!-- super-admin -->` and `<!-- /super-admin -->` show to the super admin only.
 */
function renderGuide(md: string, superAdmin: boolean) {
  const inline = (text: string): React.ReactNode[] =>
    text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)\s]+\))/g).map((part, i) => {
      if (part.startsWith("`")) return <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{part.slice(1, -1)}</code>;
      if (part.startsWith("**")) return <strong key={i} className="text-foreground">{part.slice(2, -2)}</strong>;
      if (part.startsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const external = /^https?:\/\//.test(link[2]);
        return <a key={i} href={link[2]} className="text-foreground underline underline-offset-2" {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>{inline(link[1])}</a>;
      }
      return part;
    });
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let table: string[][] | null = null;
  let hidden = false;
  const flush = () => {
    if (list) {
      const Tag = list.ordered ? "ol" : "ul";
      blocks.push(
        <Tag key={blocks.length} start={list.ordered && list.start !== 1 ? list.start : undefined} className={`${list.ordered ? "list-decimal" : "list-disc"} space-y-1.5 pl-5`}>
          {list.items.map((t, i) => <li key={i}>{inline(t)}</li>)}
        </Tag>,
      );
      list = null;
    }
    if (table) {
      const [head, ...rows] = table;
      const hasHead = head.some(Boolean);
      blocks.push(
        <div key={blocks.length} className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-[0.85em]">
            {hasHead ? <thead className="bg-muted/50 text-foreground"><tr>{head.map((c, i) => <th key={i} className="px-3 py-2 font-medium">{inline(c)}</th>)}</tr></thead> : null}
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className={hasHead || i > 0 ? "border-t" : undefined}>
                  {r.map((c, j) => <td key={j} className="px-3 py-2 align-top">{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      table = null;
    }
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    if (line === "<!-- super-admin -->") { flush(); hidden = !superAdmin; continue; }
    if (line === "<!-- /super-admin -->") { flush(); hidden = false; continue; }
    if (hidden || line.startsWith("<!--")) continue;
    if (line.startsWith("|")) {
      if (list) flush();
      if (!/^\|[\s:|-]+\|$/.test(line)) (table ??= []).push(cells(line));
      continue;
    }
    if (table) flush();
    const num = /^(\d+)\.\s/.exec(line);
    if (num || line.startsWith("- ")) {
      const ordered = Boolean(num);
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, start: num ? Number(num[1]) : 1, items: [] }; }
      list.items.push(line.replace(/^(\d+\.|-)\s/, ""));
      continue;
    }
    // An indented line continues the last list item, also after a blank line inside the list.
    if (/^\s{2,}\S/.test(raw) && list) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    if (!line) continue;
    flush();
    const heading = /^(#{2,3}) (.*?)(?:\s+\{#([a-z0-9-]+)\})?$/.exec(line);
    if (heading) {
      // "## Title {#anchor}" gives the heading a link target.
      const [, level, title, anchor] = heading;
      blocks.push(level === "##"
        ? <h2 key={blocks.length} id={anchor} className="mt-6 scroll-mt-20 text-base font-semibold text-foreground">{inline(title)}</h2>
        : <h3 key={blocks.length} id={anchor} className="mt-4 scroll-mt-20 font-semibold text-foreground">{inline(title)}</h3>);
    }
    else if (line.startsWith("# ")) continue;
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return blocks;
}

export default async function MetaLeadAdsGuide() {
  const profile = await requireProfile(["admin", "ads_manager"]);
  const md = await readFile(join(process.cwd(), "docs", "meta-lead-ads.md"), "utf8");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Facebook setup guide" description="Create the Meta app and a token that never expires, then connect Lead Ads, the ad account and clients." />
      <Card><CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">{renderGuide(md, profile.isSuperAdmin)}</CardContent></Card>
    </div>
  );
}

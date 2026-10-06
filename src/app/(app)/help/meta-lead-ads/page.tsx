import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Metadata } from "next";
import { PageHeader } from "@/components/common/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { requireProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Facebook setup guide" };

/** Renders docs/meta-lead-ads.md: headings (optionally `{#anchor}`), numbered/bulleted lists, `code` and **bold** only. */
function renderGuide(md: string) {
  const inline = (text: string) =>
    text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) =>
      part.startsWith("`") ? <code key={i} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">{part.slice(1, -1)}</code>
        : part.startsWith("**") ? <strong key={i} className="text-foreground">{part.slice(2, -2)}</strong>
          : part.startsWith("*") ? <em key={i}>{part.slice(1, -1)}</em> : part);
  const blocks: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(<Tag key={blocks.length} className={`${list.ordered ? "list-decimal" : "list-disc"} space-y-1.5 pl-5`}>{list.items.map((t, i) => <li key={i}>{inline(t)}</li>)}</Tag>);
    list = null;
  };
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd();
    const ordered = /^\d+\.\s/.test(line);
    if (ordered || line.startsWith("- ")) {
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] }; }
      list.items.push(line.replace(/^(\d+\.|-)\s/, ""));
      continue;
    }
    if (/^\s{2,}\S/.test(raw) && list) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; }
    flush();
    if (line.startsWith("## ")) {
      // "## Title {#anchor}" gives the heading a link target.
      const [, title, anchor] = /^## (.*?)(?:\s+\{#([a-z0-9-]+)\})?$/.exec(line) ?? [];
      blocks.push(<h2 key={blocks.length} id={anchor} className="mt-6 scroll-mt-20 text-base font-semibold text-foreground">{title}</h2>);
    }
    else if (line.startsWith("# ") || !line) continue;
    else blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return blocks;
}

export default async function MetaLeadAdsGuide() {
  await requireProfile(["admin", "ads_manager"]);
  const md = await readFile(join(process.cwd(), "docs", "meta-lead-ads.md"), "utf8");
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Facebook setup guide" description="Create the Meta app and a token that never expires, then connect Lead Ads, the ad account and clients." />
      <Card><CardContent className="space-y-3 text-sm leading-relaxed text-muted-foreground">{renderGuide(md)}</CardContent></Card>
    </div>
  );
}

"use client";

import { BrandMark, BrandName } from "@/components/app/brand";
import { SERIES, seriesColor } from "@/components/charts/chart";
import { Donut, Funnel, GroupedBars, MultiLine, WeekHourHeatmap } from "@/components/dashboard/widgets";
import type { ClientProfile } from "@/components/providers/profile-provider";
import { BarList, Panel, Reveal, SlideEmpty, SlideFrame, Stat, StatRow } from "@/components/reports/presentation/deck-ui";
import type { DeckData } from "@/components/reports/presentation/use-deck-data";
import type { ReportRange } from "@/components/reports/report-range-picker";
import { adKpis, ADS_CLIENT_STATUS_LABELS, type AdsOverview, moneyFormat } from "@/lib/ads";
import { categoryLabel } from "@/lib/constants";
import { formatCount, formatINR, formatINRCompact } from "@/lib/format";
import { STAGE_HEX, stageHex } from "@/lib/stages";
import { addDays, formatCalendarDate, formatDayLabel, formatMonth } from "@/lib/time";

export type Slide = { id: string; title: string; render: () => React.ReactNode };
export type DeckContext = { data: DeckData; profile: ClientProfile; range: ReportRange; generatedOn: string };

/** Chart height for a panel that fills the slide body. */
const CHART_H = 360;
const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0;
const pctText = (v: number) => `${Math.round(v)}%`;
const ratePct = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
const compactCount = new Intl.NumberFormat("en-IN", { notation: "compact", maximumFractionDigits: 1 });
const countShort = (v: number) => (Math.abs(v) >= 100_000 ? compactCount.format(v) : formatCount(Math.round(v)));
const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;
export const rangeText = (r: ReportRange) => `${formatCalendarDate(r.from)} – ${formatCalendarDate(r.to)}`;

/** Daily ad rows rolled up to weeks or months for long ranges, so bars stay readable. */
function bucketAdDays(daily: AdsOverview["daily"], days: number) {
  const unit = days > 120 ? "month" : days > 45 ? "week" : "day";
  const keyOf = (d: string) => {
    if (unit === "month") return `${d.slice(0, 7)}-01`;
    if (unit === "week") return addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
    return d;
  };
  const map = new Map<string, { spend: number; leads: number }>();
  for (const r of daily) {
    const k = keyOf(r.date);
    const cur = map.get(k) ?? { spend: 0, leads: 0 };
    cur.spend += num(r.spend);
    cur.leads += num(r.leads);
    map.set(k, cur);
  }
  const rows = [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    per: unit === "month" ? "Per month" : unit === "week" ? "Per week" : "Per day",
    labels: rows.map(([k]) => (unit === "month" ? formatMonth(k) : formatDayLabel(k))),
    spend: rows.map(([, v]) => Math.round(v.spend * 100) / 100),
    leads: rows.map(([, v]) => v.leads),
  };
}

/**
 * The slides for the current company and role, in order. A slide is left out when the role cannot
 * see its data or there is nothing to show. Per-company decks can later filter or reorder this list.
 * Each content slide's title states its main finding; the kicker names the section.
 */
export function buildSlides({ data, profile, range, generatedOn }: DeckContext): Slide[] {
  const slides: Slide[] = [];
  const { leads: L, finance: F, ads: A, clients: C } = data;
  const company = profile.company;
  const team = L?.scope === "team";
  const ov = A?.overview ?? null;
  const cur = ov?.account.currency;
  const money = moneyFormat(cur);
  const moneyShort = moneyFormat(cur, true);
  const k = ov ? adKpis(ov.totals) : null;
  const financeEmpty = !F || num(F.cards.capital_entries) + num(F.cards.expense_entries) === 0;
  const leadLabel = (p: string) => (L?.range.bucket === "month" ? formatMonth(p) : formatDayLabel(p));
  const per = L ? { day: "Per day", week: "Per week", month: "Per month" }[L.range.bucket] : "";

  const sections = [
    L ? (team ? "Sales and team" : "My sales") : null,
    A ? "Facebook Ads" : null,
    C?.total ? "Clients" : null,
    F && !financeEmpty ? "Finance" : null,
  ].filter(Boolean) as string[];

  // 1. Cover
  slides.push({
    id: "cover", title: "Cover",
    render: () => (
      <div className="flex h-full flex-col justify-between px-20 py-16">
        <Reveal delay={0}>
          <div className="flex items-center gap-3">
            <BrandMark size={36} logoUrl={company.logoUrl} alt="" />
            <span className="text-[15px] text-muted-foreground">{company.name}</span>
          </div>
        </Reveal>
        <div>
          <Reveal delay={120}><p className="text-[18px] text-muted-foreground">Business review</p></Reveal>
          <Reveal delay={200}>
            <h1 className="mt-3 text-[72px] leading-[1.05] font-semibold tracking-[-0.02em]">
              <BrandName name={company.name} highlight={company.brandHighlight} />
            </h1>
          </Reveal>
          <Reveal delay={280}><p className="mt-5 text-[22px] text-muted-foreground">{rangeText(range)}</p></Reveal>
        </div>
        <Reveal delay={360}>
          <div className="flex items-end justify-between gap-8 border-t border-white/10 pt-5 text-[14px] text-muted-foreground">
            <span>{sections.join("  ·  ")}</span>
            <span className="shrink-0">Prepared by {profile.display_name} · {generatedOn}</span>
          </div>
        </Reveal>
      </div>
    ),
  });

  // 2. At a glance
  type Tile = React.ComponentProps<typeof Stat>;
  const primary: Tile[] = [];
  const extra: Tile[] = [];
  if (L) {
    const c = L.cards;
    primary.push(
      { label: "Leads created", value: num(c.created), format: formatCount },
      { label: "Won", value: num(c.won), format: formatCount, hint: `${formatCount(c.lost)} lost` },
      { label: "Win rate", value: ratePct(num(c.won), num(c.won) + num(c.lost)), format: pctText, hint: "Won ÷ (won + lost)" },
    );
    extra.push(
      { label: "Overdue follow-ups", value: num(c.overdue_now), format: formatCount, hint: "Pending and past due now", alert: num(c.overdue_now) > 0 },
      { label: "Follow-ups done", value: num(c.follow_ups_completed), format: formatCount, hint: `${formatCount(c.follow_ups_scheduled)} scheduled` },
      { label: "Calls logged", value: num(c.calls), format: formatCount, hint: `${formatCount(c.notes)} notes` },
    );
  }
  if (ov && k) {
    primary.push(
      { label: "Ad spend", value: num(ov.totals.spend), format: moneyShort, hint: money(ov.totals.spend) },
      { label: "Leads from ads", value: num(ov.totals.leads), format: formatCount },
      { label: "Cost per lead", value: k.cpl, format: money },
    );
    extra.push({ label: "Ad impressions", value: num(ov.totals.impressions), format: countShort });
  }
  if (F && !financeEmpty) {
    primary.push(
      { label: "Operating expenses", value: num(F.cards.expense_total), format: formatINRCompact, hint: formatINR(F.cards.expense_total) },
      { label: "Capital contributed", value: num(F.cards.capital_total), format: formatINRCompact, hint: "Money put in, not revenue" },
    );
    extra.push({ label: "Avg expense / month", value: num(F.cards.expense_total) / Math.max(1, F.range.months), format: formatINRCompact });
  }
  const tiles = [...primary, ...extra].slice(0, 8);
  if (tiles.length) {
    slides.push({
      id: "glance", title: "At a glance",
      render: () => (
        <SlideFrame kicker="Summary" title="At a glance" subtitle={rangeText(range)}>
          <div className="grid grid-cols-4 gap-x-10 gap-y-14 pt-2">
            {tiles.map((t, i) => <Stat key={t.label} {...t} step={i} />)}
          </div>
        </SlideFrame>
      ),
    });
  }

  if (L) {
    const c = L.cards;
    const wr = ratePct(num(c.won), num(c.won) + num(c.lost));
    // 3. Lead trend
    slides.push({
      id: "lead-trend", title: "Lead trend",
      render: () => (
        <SlideFrame
          kicker="Sales"
          title={`${formatCount(c.created)} leads created, ${formatCount(c.won)} won${wr === null ? "" : ` at a ${pctText(wr)} win rate`}`}
          subtitle={`${team ? "Whole team" : "My leads"}. Won and lost count the day a lead was closed.`}
        >
          <div className="flex h-full flex-col gap-8">
            <StatRow>
              <Stat size="md" label="Created" value={num(c.created)} format={formatCount} step={0} />
              <Stat size="md" label="Won" value={num(c.won)} format={formatCount} step={1} />
              <Stat size="md" label="Lost" value={num(c.lost)} format={formatCount} step={2} />
              <Stat size="md" label="Avg days to win" value={c.avg_days_to_win} format={(v) => String(Math.round(v))} step={3} />
            </StatRow>
            <Panel title="Leads over time" note={per} step={4} className="flex-1">
              <MultiLine
                height={250}
                categories={L.trend.map((p) => leadLabel(p.period))}
                series={[
                  { name: "Created", values: L.trend.map((p) => p.created), color: SERIES[0] },
                  { name: "Won", values: L.trend.map((p) => p.won), color: STAGE_HEX.emerald },
                  { name: "Lost", values: L.trend.map((p) => p.lost), color: STAGE_HEX.red },
                ]}
              />
            </Panel>
          </div>
        </SlideFrame>
      ),
    });

    // 4. Pipeline
    const first = L.funnel[0]?.count ?? 0;
    const last = L.funnel[L.funnel.length - 1];
    slides.push({
      id: "pipeline", title: "Pipeline",
      render: () => (
        <SlideFrame
          kicker="Sales"
          title={first && last ? `${pctText((last.count / first) * 100)} of new leads reached ${last.name}` : "Pipeline"}
          subtitle="Leads created in this range: the furthest stage they reached, and where they are now"
        >
          <div className="grid h-full grid-cols-2 gap-12">
            <Panel title="Furthest stage reached" note="Share of all created">
              <Funnel height={CHART_H} steps={L.funnel.map((f) => ({ name: f.name, value: f.count }))} />
            </Panel>
            <Panel title="Current stage" step={1}>
              <div className="flex h-full items-center">
                <div className="w-full">
                  <Donut size={210} totalLabel="leads" items={L.cohort_status.map((s) => ({ name: s.name, value: s.count, color: stageHex(s.color) }))} />
                </div>
              </div>
            </Panel>
          </div>
        </SlideFrame>
      ),
    });

    // 5. Team performance (admin)
    const people = L.salespeople ?? [];
    if (team && people.length) {
      const board = [...people].sort((a, b) => b.won - a.won || b.created - a.created).slice(0, 5);
      const top = board[0];
      slides.push({
        id: "team", title: "Team performance",
        render: () => (
          <SlideFrame
            kicker="Team"
            title={top.won > 0 ? `${top.name} leads the team with ${plural(top.won, "deal")} won` : "Team performance"}
            subtitle="Leads each person owns now, created and closed in this range"
          >
            <div className="grid h-full grid-cols-[1.4fr_1fr] gap-12">
              <Panel title="By salesperson">
                <GroupedBars
                  height={CHART_H - 20}
                  categories={people.map((s) => s.name)}
                  series={[
                    { name: "Created", values: people.map((s) => s.created), color: SERIES[0] },
                    { name: "Won", values: people.map((s) => s.won), color: STAGE_HEX.emerald },
                    { name: "Lost", values: people.map((s) => s.lost), color: STAGE_HEX.red },
                  ]}
                />
              </Panel>
              <Panel title="Most deals won" step={1}>
                <BarList
                  step={2}
                  rows={board.map((s) => {
                    const r = ratePct(s.won, s.won + s.lost);
                    return {
                      key: s.id, label: s.name, value: s.won, display: `${formatCount(s.won)} won`,
                      extra: `${r === null ? "—" : pctText(r)} win rate`,
                    };
                  })}
                />
              </Panel>
            </div>
          </SlideFrame>
        ),
      });
    }

    // 6. Follow-ups and activity
    const o = L.follow_up_outcomes;
    const due = num(o.on_time) + num(o.late) + num(o.cancelled) + num(o.overdue);
    const outcomeTotal = due + num(o.upcoming);
    if (outcomeTotal + num(c.notes) + num(c.calls) + L.heatmap.length > 0) {
      const onTime = ratePct(num(o.on_time), due);
      slides.push({
        id: "activity", title: "Follow-ups and activity",
        render: () => (
          <SlideFrame
            kicker="Activity"
            title={onTime === null ? "Follow-ups and activity" : `${pctText(onTime)} of follow-ups due were done on time`}
            subtitle="Follow-ups due in this range, and when the work happens"
          >
            <div className="grid h-full grid-cols-[1fr_1.25fr] gap-12">
              <div className="flex min-h-0 flex-col gap-8">
                <Panel title="Follow-up outcomes" className="flex-1">
                  <Donut size={160} totalLabel="follow-ups" items={[
                    { name: "On time", value: num(o.on_time), color: SERIES[2] },
                    { name: "Late", value: num(o.late), color: SERIES[3] },
                    { name: "Cancelled", value: num(o.cancelled), color: "#737373" },
                    { name: "Overdue", value: num(o.overdue), color: SERIES[1] },
                    { name: "Upcoming", value: num(o.upcoming), color: SERIES[0] },
                  ]} />
                </Panel>
                <StatRow>
                  <Stat size="md" label="Notes" value={num(c.notes)} format={formatCount} step={2} />
                  <Stat size="md" label="Calls" value={num(c.calls)} format={formatCount} step={3} />
                  <Stat size="md" label="Completed" value={num(c.follow_ups_completed)} format={formatCount} step={4} />
                </StatRow>
              </div>
              <Panel title="When work happens" note="Weekday × hour, IST" step={1}>
                {L.heatmap.length ? <WeekHourHeatmap height={CHART_H - 10} cells={L.heatmap} label="activities" /> : <SlideEmpty text="No activity recorded in this range." />}
              </Panel>
            </div>
          </SlideFrame>
        ),
      });
    }

    // 7. Niches
    if (L.niches.length) {
      const best = [...L.niches].filter((n) => n.created > 0).sort((a, b) => b.won - a.won || b.won / b.created - a.won / a.created || b.created - a.created).slice(0, 5);
      const lead = [...L.niches].sort((a, b) => b.created - a.created)[0];
      slides.push({
        id: "niches", title: "Niches",
        render: () => (
          <SlideFrame
            kicker="Sales"
            title={best[0]?.won ? `${best[0].name} brings the most wins` : `${lead.name} brings the most leads`}
            subtitle="Leads created in this range per niche, and how many are won (top 10)"
          >
            <div className="grid h-full grid-cols-[1.5fr_1fr] gap-12">
              <Panel title="Leads by niche">
                <GroupedBars
                  height={CHART_H}
                  categories={L.niches.map((n) => n.name)}
                  series={[
                    { name: "Created", values: L.niches.map((n) => n.created), color: SERIES[0] },
                    { name: "Won", values: L.niches.map((n) => n.won), color: STAGE_HEX.emerald },
                  ]}
                />
              </Panel>
              <Panel title="Most won" step={1}>
                <BarList step={2} rows={best.map((n) => ({
                  key: n.name, label: n.name, value: n.won, display: `${formatCount(n.won)} won`,
                  extra: `of ${formatCount(n.created)} (${pctText((n.won / n.created) * 100)})`,
                }))} />
              </Panel>
            </div>
          </SlideFrame>
        ),
      });
    }
  }

  // 8–9. Facebook Ads
  if (A) {
    if (!ov || !k) {
      slides.push({
        id: "ads", title: "Facebook Ads",
        render: () => (
          <SlideFrame kicker="Facebook Ads" title="No ad account connected">
            <SlideEmpty text={`Connect ${company.name}'s Meta ad account on the Ads page to include ad results here.`} />
          </SlideFrame>
        ),
      });
    } else {
      const t = ov.totals;
      const b = bucketAdDays(ov.daily, ov.range.days);
      slides.push({
        id: "ads", title: "Ads performance",
        render: () => (
          <SlideFrame
            kicker="Facebook Ads"
            title={`${moneyShort(t.spend)} spent for ${plural(num(t.leads), "lead")}${k.cpl === null ? "" : ` at ${money(k.cpl)} each`}`}
            subtitle={`${ov.account.name ?? `Ad account ${ov.account.act_id}`} · ${formatCount(t.active_campaigns)} of ${plural(num(t.campaigns), "campaign")} active`}
          >
            <div className="flex h-full flex-col gap-8">
              <StatRow>
                <Stat size="md" label="Spend" value={num(t.spend)} format={moneyShort} step={0} />
                <Stat size="md" label="Impressions" value={num(t.impressions)} format={countShort} step={1} />
                <Stat size="md" label="Clicks" value={num(t.clicks)} format={countShort} step={2} />
                <Stat size="md" label="CTR" value={k.ctr} format={(v) => `${v.toFixed(2)}%`} step={3} />
                <Stat size="md" label="Leads" value={num(t.leads)} format={countShort} step={4} />
                <Stat size="md" label="Cost per lead" value={k.cpl} format={money} step={5} />
              </StatRow>
              <div className="grid min-h-0 flex-1 grid-cols-2 gap-12">
                <Panel title="Spend" note={b.per} step={6}>
                  <MultiLine height={230} format={moneyShort} categories={b.labels} series={[{ name: "Spend", values: b.spend, color: SERIES[0] }]} />
                </Panel>
                <Panel title="Leads" note={b.per} step={7}>
                  <GroupedBars height={230} categories={b.labels} series={[{ name: "Leads", values: b.leads, color: STAGE_HEX.emerald }]} />
                </Panel>
              </div>
            </div>
          </SlideFrame>
        ),
      });

      const camps = ov.campaigns.slice(0, 7);
      if (camps.length) {
        const cheapest = ov.campaigns.filter((x) => num(x.leads) > 0)
          .map((x) => ({ ...x, cpl: num(x.spend) / num(x.leads) })).sort((a, b) => a.cpl - b.cpl).slice(0, 5);
        const totalSpend = num(t.spend);
        const share = totalSpend > 0 ? (num(camps[0].spend) / totalSpend) * 100 : null;
        slides.push({
          id: "campaigns", title: "Top campaigns",
          render: () => (
            <SlideFrame
              kicker="Facebook Ads"
              title={share === null ? "Top campaigns" : `${camps[0].name} took ${pctText(share)} of ad spend`}
              subtitle="Campaigns by spend in this range"
            >
              <div className="grid h-full grid-cols-[1.4fr_1fr] gap-12">
                <Panel title="Spend by campaign">
                  <BarList rows={camps.map((x) => ({
                    key: x.id, label: x.name, value: num(x.spend), display: moneyShort(x.spend),
                    extra: `${formatCount(num(x.leads))} leads`,
                  }))} />
                </Panel>
                <Panel title="Lowest cost per lead" step={1}>
                  {cheapest.length ? (
                    // Bar = efficiency against the cheapest campaign (shortest bar = most expensive lead).
                    <BarList step={2} rows={cheapest.map((x) => ({
                      key: x.id, label: x.name, value: x.cpl > 0 ? cheapest[0].cpl / x.cpl : 1, display: money(x.cpl),
                      extra: `${formatCount(num(x.leads))} leads`,
                    }))} />
                  ) : <SlideEmpty text="No leads from ads in this range." />}
                </Panel>
              </div>
            </SlideFrame>
          ),
        });
      }
    }
  }

  // 10. Clients
  if (C && C.total > 0) {
    const counts = { onboarding: 0, active: 0, paused: 0, closed: 0 };
    for (const x of C.items) counts[x.status] += 1;
    const top = C.items.filter((x) => num(x.last_30d.spend) > 0).sort((a, b) => num(b.last_30d.spend) - num(a.last_30d.spend)).slice(0, 5);
    slides.push({
      id: "clients", title: "Clients",
      render: () => (
        <SlideFrame
          kicker="Clients"
          title={`${plural(counts.active, "active client")} out of ${formatCount(C.total)}`}
          subtitle={`Businesses ${company.name} runs ads for`}
        >
          <div className="flex h-full flex-col gap-8">
            <StatRow>
              {(["active", "onboarding", "paused", "closed"] as const).map((s, i) => (
                <Stat key={s} size="md" label={ADS_CLIENT_STATUS_LABELS[s]} value={counts[s]} format={(v) => formatCount(Math.round(v))} step={i} />
              ))}
            </StatRow>
            <Panel title="Top clients by ad spend" note="Last 30 days" step={4} className="flex-1">
              {top.length ? (
                <BarList step={5} rows={top.map((x) => ({
                  key: x.id, label: x.name, sub: x.business ?? undefined, value: num(x.last_30d.spend),
                  display: moneyFormat(x.account?.currency, true)(x.last_30d.spend), extra: `${formatCount(num(x.last_30d.leads))} leads`,
                }))} />
              ) : <SlideEmpty text="No client ad spend in the last 30 days." />}
            </Panel>
          </div>
        </SlideFrame>
      ),
    });
  }

  // 11–12. Finance
  if (F && !financeEmpty) {
    const fc = F.cards;
    const fLabel = (p: string) => (F.range.bucket === "month" ? formatMonth(p) : formatDayLabel(p));
    slides.push({
      id: "finance", title: "Finance overview",
      render: () => (
        <SlideFrame
          kicker="Finance"
          title={`${formatINRCompact(fc.expense_total)} spent on operations, ${formatINRCompact(fc.capital_total)} capital put in`}
          subtitle="Shown side by side, not netted: capital is money put into the business, not revenue"
        >
          <div className="flex h-full flex-col gap-8">
            <StatRow>
              <Stat size="md" label="Capital contributed" value={num(fc.capital_total)} format={formatINRCompact} hint={plural(num(fc.capital_entries), "entry", "entries")} />
              <Stat size="md" label="Operating expenses" value={num(fc.expense_total)} format={formatINRCompact} hint={plural(num(fc.expense_entries), "entry", "entries")} step={1} />
              <Stat size="md" label="Average per month" value={num(fc.expense_total) / Math.max(1, F.range.months)} format={formatINRCompact} hint={`Over ${plural(F.range.months, "month")}`} step={2} />
            </StatRow>
            <div className="grid min-h-0 flex-1 grid-cols-[1.4fr_1fr] gap-12">
              <Panel title="Capital and expenses" step={3}>
                <GroupedBars
                  height={220} format={formatINRCompact}
                  categories={F.trend.map((p) => fLabel(p.period))}
                  series={[
                    { name: "Capital", values: F.trend.map((p) => num(p.capital)), color: SERIES[2] },
                    { name: "Expenses", values: F.trend.map((p) => num(p.expense)), color: SERIES[1] },
                  ]}
                />
              </Panel>
              <Panel title="Expenses by category" step={4}>
                <Donut size={150} format={formatINRCompact} totalLabel="total"
                  items={F.categories.slice(0, 6).map((x) => ({ name: categoryLabel(x.category), value: num(x.total), color: seriesColor(x.category) }))} />
              </Panel>
            </div>
          </div>
        </SlideFrame>
      ),
    });

    if (F.top_expenses.length || F.contributors.length) {
      const topCat = F.categories[0];
      slides.push({
        id: "money", title: "Where the money went",
        render: () => (
          <SlideFrame
            kicker="Finance"
            title={topCat ? `${categoryLabel(topCat.category)} is the largest cost at ${formatINRCompact(topCat.total)}` : "Where the money went"}
            subtitle="Largest operating expenses, and who contributed capital in this range"
          >
            <div className="grid h-full grid-cols-2 gap-12">
              <Panel title="Largest expenses">
                {F.top_expenses.length ? (
                  <BarList rows={F.top_expenses.slice(0, 6).map((e) => ({
                    key: e.id, label: categoryLabel(e.category), sub: e.item ?? e.description ?? undefined,
                    value: num(e.amount), display: formatINRCompact(e.amount), extra: formatCalendarDate(e.date),
                  }))} />
                ) : <SlideEmpty text="No expenses in this range." />}
              </Panel>
              <Panel title="Capital by contributor" step={1}>
                {F.contributors.length ? (
                  <BarList step={2} rows={F.contributors.slice(0, 6).map((x) => ({
                    key: x.name, label: x.name, value: num(x.total), display: formatINRCompact(x.total), extra: plural(num(x.entries), "entry", "entries"),
                  }))} />
                ) : <SlideEmpty text="No capital contributed in this range." />}
              </Panel>
            </div>
          </SlideFrame>
        ),
      });
    }
  }

  // 13. Closing
  const highlights: { label: string; value: string; sub: string }[] = [];
  if (L) {
    const wr = ratePct(num(L.cards.won), num(L.cards.won) + num(L.cards.lost));
    if (wr !== null) highlights.push({ label: "Win rate", value: pctText(wr), sub: `${formatCount(L.cards.won)} won of ${formatCount(num(L.cards.won) + num(L.cards.lost))} closed` });
    const star = team ? [...(L.salespeople ?? [])].sort((a, b) => b.won - a.won)[0] : undefined;
    if (star && star.won > 0) highlights.push({ label: "Top closer", value: star.name, sub: `${formatCount(star.won)} won` });
    const niche = [...L.niches].sort((a, b) => b.won - a.won || b.created - a.created)[0];
    if (niche) highlights.push({ label: "Top niche", value: niche.name, sub: `${formatCount(niche.created)} leads, ${formatCount(niche.won)} won` });
  }
  if (ov) {
    const best = ov.campaigns.filter((x) => num(x.leads) > 0).sort((a, b) => num(a.spend) / num(a.leads) - num(b.spend) / num(b.leads))[0];
    if (best) highlights.push({ label: "Best campaign", value: best.name, sub: `${money(num(best.spend) / num(best.leads))} per lead` });
  }
  if (C && C.total > 0) {
    const active = C.items.filter((x) => x.status === "active").length;
    highlights.push({ label: "Active clients", value: formatCount(active), sub: `of ${plural(C.total, "client")}` });
  }
  if (F && F.categories.length) {
    const topCat = F.categories[0];
    highlights.push({ label: "Largest cost", value: categoryLabel(topCat.category), sub: formatINR(topCat.total) });
  }
  slides.push({
    id: "closing", title: "Thank you",
    render: () => (
      <div className="flex h-full flex-col justify-between px-20 py-16">
        <div>
          <Reveal delay={0}><p className="text-[18px] text-muted-foreground">{company.name} · {rangeText(range)}</p></Reveal>
          <Reveal delay={100}><h2 className="mt-3 text-[64px] leading-none font-semibold tracking-[-0.02em]">Thank you</h2></Reveal>
        </div>
        {highlights.length ? (
          <div className="grid grid-cols-3 gap-x-12 gap-y-10">
            {highlights.slice(0, 6).map((h, i) => (
              <Reveal key={h.label} delay={220 + i * 70}>
                <div className="border-t border-white/10 pt-4">
                  <p className="text-[14px] text-muted-foreground">{h.label}</p>
                  <p className="mt-2 truncate text-[24px] font-semibold">{h.value}</p>
                  <p className="mt-1 truncate text-[14px] text-muted-foreground">{h.sub}</p>
                </div>
              </Reveal>
            ))}
          </div>
        ) : null}
      </div>
    ),
  });

  return slides;
}

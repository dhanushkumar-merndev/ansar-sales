"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, MessageCircle, Phone, Send, Smartphone } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import { StatusBadge } from "@/components/common/badges";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CallNotes, useLeadNotes } from "@/components/leads/call-notes";
import {
  CallWrapUpFields, changesOf, EMPTY_WRAP_UP, isWrapUpDirty, TalkTimer, useCallLead, useTalkSeconds, WrapUpConfirm, type WrapUp,
} from "@/components/leads/call-wrap-up";
import { ShareFilesDialog } from "@/components/leads/share-files-dialog";
import { TemperatureBadge } from "@/components/leads/temperature-select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { parseFormAnswers } from "@/lib/form-answers";
import type { LeadDetail } from "@/lib/lead-queries";
import { whatsappUrl } from "@/lib/library";
import type { LeadNote } from "@/lib/queries";
import { formatDate } from "@/lib/time";
import { finishCall, logCall, setCallDuration } from "@/server/actions/calls";

export { CallOutcomePicker } from "@/components/leads/call-wrap-up";

const DIAL_WAIT_MS = 1200;

/** A computer with a mouse can't dial: it shows a QR code for the phone instead. */
const isDesktop = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/**
 * Starts a call: logs it in the lead's timeline, then opens the phone dialer
 * (phones) or a QR code to scan with a phone (desktop). Dialing never waits
 * more than ~1 s for the log to be saved.
 *
 * Talk time runs from pressing Call until Save or Skip on the call screen (desktop) or until
 * the person comes back to the app after dialing (phone); it is saved on the call.
 */
export function useLeadCall(leadId: string, phone: string, onLogged?: () => void) {
  const [starting, setStarting] = useState(false);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [dialing, setDialing] = useState(false);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [talkStartedAt, setTalkStartedAt] = useState<number | null>(null);
  const startedAt = useRef<number | null>(null);
  const logged = useRef<Promise<string | null> | null>(null);
  const stopping = useRef<Promise<void>>(Promise.resolve());
  // Bumped when a call is finished or skipped, so a log that answers late doesn't reopen anything.
  const session = useRef(0);

  async function stop() {
    if (startedAt.current === null) return;
    const seconds = Math.round((Date.now() - startedAt.current) / 1000);
    startedAt.current = null;
    setTalkStartedAt(null);
    setDurationSeconds(seconds);
    const id = await logged.current;
    if (!id) return;
    const r = await setCallDuration({ activityId: id, seconds });
    if (!r.ok) toast.error(`Talk time not saved: ${r.error}`);
    else onLogged?.();
  }
  /** Stops the talk time (once) and resolves when it is saved: saving the result must not race it on the same row. */
  function halt() {
    if (startedAt.current !== null) stopping.current = stop();
    return stopping.current;
  }
  const haltRef = useRef(halt);
  useEffect(() => { haltRef.current = halt; });

  // On a phone the dialer takes over the screen; the call is over when the app is visible again.
  useEffect(() => {
    if (!dialing) return;
    let left = document.visibilityState === "hidden";
    const onChange = () => {
      if (document.visibilityState === "hidden") left = true;
      else if (left) { setDialing(false); void haltRef.current(); }
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [dialing]);

  async function start() {
    if (starting) return;
    const mine = ++session.current;
    setStarting(true);
    setDurationSeconds(null);
    startedAt.current = Date.now();
    setTalkStartedAt(startedAt.current);
    const logging = logCall({ leadId });
    logged.current = logging.then((r) => (r.ok ? r.data.activityId : null));
    if (isDesktop()) setQrOpen(true);
    else {
      setDialing(true);
      await Promise.race([logging, new Promise((r) => setTimeout(r, DIAL_WAIT_MS))]);
      window.location.href = `tel:${phone}`;
    }
    const r = await logging;
    setStarting(false);
    if (!r.ok) {
      startedAt.current = null; setTalkStartedAt(null); setDialing(false); setQrOpen(false);
      toast.error(`Call not logged: ${r.error}`);
      return;
    }
    onLogged?.();
    if (session.current === mine) setActivityId(r.data.activityId);
  }

  function end() {
    session.current++;
    setActivityId(null); setQrOpen(false); setDialing(false); setDurationSeconds(null);
  }

  /** Saves the result, note, status and temperature (in that order); false keeps the screen open. */
  async function save(w: WrapUp, lead: LeadDetail | null | undefined) {
    const c = changesOf(w, lead);
    if (!c.outcome) { toast.error("Choose how the call went."); return false; }
    const id = await logged.current;
    if (!id) { toast.error("The call wasn't logged, so it can't be saved."); return false; }
    await halt();
    const r = await finishCall({ activityId: id, outcome: c.outcome, note: c.note || undefined, stageId: c.stageId, temperature: c.temperature });
    if (!r.ok) { toast.error(r.fieldErrors?.note?.[0] ?? r.error); return false; }
    toast.success("Call saved");
    onLogged?.();
    end();
    return true;
  }

  return {
    start, starting, activityId, qrOpen, durationSeconds, talkStartedAt, halt, save,
    /** Follow-up completion: closes the QR code; that dialog asks the result itself. */
    closeQr: () => { setQrOpen(false); void halt(); },
    /** Ends the call without a result: it stays in the timeline with its talk time. */
    skip: () => { void halt(); end(); },
  };
}

export function CallButton({ leadId, phone, leadName, onLogged, className, size, variant, iconOnly }: {
  leadId: string; phone: string; leadName: string; onLogged?: () => void; className?: string;
  size?: "default" | "sm" | "icon-sm"; variant?: "default" | "outline" | "ghost"; iconOnly?: boolean;
}) {
  const call = useLeadCall(leadId, phone, onLogged);
  return (
    <>
      <Button size={size} variant={variant} className={className} onClick={() => void call.start()} disabled={call.starting} aria-label={iconOnly ? `Call ${leadName}` : undefined}>
        {call.starting ? <Loader2 className="animate-spin" /> : <Phone />}{iconOnly ? null : " Call"}
      </Button>
      <CallQrDialog open={call.qrOpen} onClose={call.skip} leadId={leadId} phone={phone} leadName={leadName} wrapUp={call} />
      {/* Phones: asked when the person comes back from the dialer (desktop asks on the call screen). */}
      <CallOutcomeDialog open={!call.qrOpen && !!call.activityId} call={call} leadId={leadId} leadName={leadName} />
    </>
  );
}

/** Opens a WhatsApp chat with the number (the app on phones, WhatsApp Web/desktop otherwise). */
export function WhatsAppButton({ phone, className, size }: { phone: string; className?: string; size?: "default" | "sm" }) {
  return (
    <Button asChild variant="outline" size={size} className={className}>
      <a href={whatsappUrl(phone)} target="_blank" rel="noopener noreferrer"><MessageCircle /> WhatsApp</a>
    </Button>
  );
}

type WrapUpCall = Pick<ReturnType<typeof useLeadCall>, "save" | "skip" | "halt" | "talkStartedAt" | "durationSeconds">;

/** The Facebook form answers note (written by the system, not a person), if the lead has one. */
const formAnswersOf = (notes: LeadNote[] | undefined) => {
  for (const n of notes ?? []) {
    const answers = n.actor ? null : parseFormAnswers(n.body);
    if (answers) return answers;
  }
  return null;
};

/**
 * Full-screen call screen: the lead's details, a QR code that opens the phone's dialer, Send documents,
 * and the lead's earlier notes. With `wrapUp` it also takes the call's result, status, temperature and
 * note, saved together on Save; Skip (or X, Esc, a click outside) leaves the call without a result.
 * Without it (follow-up completion), Done just closes it. Closing by accident always asks first.
 */
export function CallQrDialog({ open, onClose, leadId, phone, leadName, wrapUp }: {
  open: boolean; onClose: () => void; leadId: string; phone: string; leadName: string; wrapUp?: WrapUpCall;
}) {
  const [confirmClose, setConfirmClose] = useState(false);
  const [confirmSave, setConfirmSave] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [value, setValue] = useState<WrapUp>(EMPTY_WRAP_UP);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setValue(EMPTY_WRAP_UP); setConfirmSave(false); setConfirmClose(false); }
  }
  const lead = useCallLead(leadId, open);
  const notes = useLeadNotes(leadId, open);
  const live = useTalkSeconds(wrapUp?.talkStartedAt ?? null);
  const talkSeconds = live ?? wrapUp?.durationSeconds ?? null;
  const dirty = isWrapUpDirty(value);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phone);
      toast.success("Number copied");
    } catch {
      toast.error("Couldn't copy the number.");
    }
  };
  const askSave = () => {
    if (!value.outcome) return void toast.error("Choose how the call went.");
    void wrapUp?.halt(); // the call is over: freeze the talk time shown in the confirmation
    setConfirmSave(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && setConfirmClose(true)}>
        {/* Full screen. Wide screens: details + QR on the left (scrolls), result and notes on the right.
            Narrower: everything stacks in one scrolling column. Ctrl/⌘ + Enter saves. */}
        <DialogContent
          className="flex h-[calc(100svh-1rem)] flex-col gap-4 p-4 sm:h-[calc(100svh-2rem)] sm:max-w-[calc(100%-2rem)] sm:p-6"
          onKeyDown={(e) => {
            if (wrapUp && e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); askSave(); }
          }}
        >
          <DialogHeader className="flex-row items-center gap-3 pr-8 text-left">
            <div className="min-w-0 flex-1">
              <DialogTitle className="truncate text-lg">Call {leadName}</DialogTitle>
              <DialogDescription className="flex items-center gap-1.5">
                <Smartphone className="size-4 shrink-0" /> Scan the QR code with your phone&apos;s camera to dial.
              </DialogDescription>
            </div>
            {wrapUp && talkSeconds !== null ? <TalkTimer seconds={talkSeconds} live={live !== null} /> : null}
          </DialogHeader>
          <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 [scrollbar-width:thin] sm:-mx-6 sm:px-6 lg:grid lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-6 lg:overflow-hidden">
            <aside
              aria-label="Lead details"
              className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_15rem] lg:-mr-2 lg:flex lg:min-h-0 lg:flex-col lg:overflow-y-auto lg:pr-2 lg:[scrollbar-width:thin]"
            >
              <CallLeadInfo lead={lead.data} loading={lead.isInitialLoading} answers={formAnswersOf(notes.data)} />
              <div className="flex flex-col items-center gap-2 self-start rounded-lg border p-3 lg:self-auto">
                <div className="rounded-lg bg-white p-2.5">
                  <QRCodeSVG value={`tel:${phone}`} size={148} marginSize={0} aria-label={`QR code to call ${phone}`} />
                </div>
                <button
                  type="button"
                  onClick={() => void copy()}
                  title="Copy number"
                  className="inline-flex items-center gap-1.5 rounded text-lg font-semibold tracking-wide tabular-nums hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {phone} <Copy className="size-3.5 text-muted-foreground" aria-hidden />
                </button>
                <p className="text-center text-xs text-muted-foreground">Already logged in the timeline.</p>
                <div className="grid w-full grid-cols-2 gap-2">
                  <Button variant="outline" size="sm" onClick={() => setShareOpen(true)}><Send /> Send docs</Button>
                  <Button asChild variant="outline" size="sm">
                    <a href={whatsappUrl(phone)} target="_blank" rel="noopener noreferrer"><MessageCircle /> WhatsApp</a>
                  </Button>
                </div>
              </div>
            </aside>
            <div className="mt-4 flex min-h-0 flex-col gap-4 lg:mt-0 lg:border-l lg:pl-6">
              {wrapUp ? (
                <section aria-label="Call result" className="rounded-lg border bg-muted/20 p-3 sm:p-4">
                  <CallWrapUpFields value={value} onChange={setValue} lead={lead.data} talkSeconds={talkSeconds} />
                </section>
              ) : null}
              {open ? <CallNotes leadId={leadId} notes={notes} className="min-h-72 lg:min-h-0 lg:flex-1" /> : null}
            </div>
          </div>
          <DialogFooter className="-mx-4 -mb-4 mt-0 flex-row flex-wrap items-center justify-between sm:-mx-6 sm:-mb-6 sm:justify-between">
            <Button variant="ghost" onClick={() => void copy()}><Copy /> <span className="hidden sm:inline">Copy number</span><span className="sm:hidden">Copy</span></Button>
            {wrapUp ? (
              <div className="flex items-center gap-2">
                {!value.outcome ? <span className="hidden text-xs text-muted-foreground md:inline">Pick how the call went to save</span> : null}
                <Button variant="outline" onClick={() => (dirty ? setConfirmClose(true) : onClose())}>Skip</Button>
                <Button onClick={askSave} disabled={!value.outcome} title="Save (Ctrl + Enter)">Save call</Button>
              </div>
            ) : (
              <Button onClick={onClose}>Done</Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {open ? <ShareFilesDialog open={shareOpen} onOpenChange={setShareOpen} leadId={leadId} leadName={leadName} phone={phone} onShared={notes.refetch} /> : null}
      {wrapUp ? (
        <WrapUpConfirm
          open={open && confirmSave}
          onOpenChange={setConfirmSave}
          changes={changesOf(value, lead.data)}
          lead={lead.data}
          talkSeconds={talkSeconds}
          onConfirm={() => wrapUp.save(value, lead.data)}
        />
      ) : null}
      <ConfirmDialog
        open={open && confirmClose}
        onOpenChange={setConfirmClose}
        title={wrapUp ? (dirty ? "Discard what you entered?" : "Close without a result?") : "Close the call screen?"}
        description={
          wrapUp
            ? `The call stays in the timeline with its talk time${dirty ? ", but the result, status, temperature and note you picked are not saved" : ", without a result"}.`
            : "The call is already logged. You'll be asked how it went next."
        }
        confirmLabel={wrapUp ? (dirty ? "Discard" : "Close") : "Close"}
        destructive={wrapUp && dirty}
        onConfirm={async () => onClose()}
      />
    </>
  );
}

/** Who the lead is, where they came from and where they stand, beside the QR code. */
function CallLeadInfo({ lead, loading, answers }: { lead: LeadDetail | null | undefined; loading: boolean; answers: ReturnType<typeof parseFormAnswers> }) {
  if (!lead) return loading ? <Skeleton className="h-56 rounded-lg" /> : null;
  const source = lead.source === "facebook"
    ? [["Form", lead.source_meta.form_name], ["Ad", lead.source_meta.ad_name], ["Campaign", lead.source_meta.campaign_name]] as const
    : [];
  const rows: [string, React.ReactNode][] = [
    ...(lead.company_name ? [["Company", lead.company_name] as [string, React.ReactNode]] : []),
    ["Phone", <span key="p" className="tabular-nums">{lead.phone}</span>],
    ...(lead.email ? [["Email", <span key="e" className="block truncate" title={lead.email}>{lead.email}</span>] as [string, React.ReactNode]] : []),
    ["Niche", lead.niche.name],
    ["Source", lead.source === "facebook" ? "Facebook" : "Added by hand"],
    ...source.filter(([, v]) => v).map(([k, v]) => [k, v] as [string, React.ReactNode]),
    ["Owner", lead.owner.display_name],
    ["Added", formatDate(lead.created_at)],
  ];
  return (
    <section className="space-y-3 rounded-lg border bg-muted/20 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Now</span>
        <StatusBadge stageId={lead.stage_id} status={lead.status} />
        {lead.temperature ? <TemperatureBadge value={lead.temperature} /> : null}
      </div>
      <dl className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>
      {answers?.length ? (
        <div className="border-t pt-2">
          <p className="mb-1 text-xs font-medium text-muted-foreground">Form answers</p>
          <dl className="space-y-1.5">
            {answers.map((x, i) => (
              <div key={i}>
                {x.question ? <dt className="text-xs text-muted-foreground">{x.question}</dt> : null}
                <dd className="whitespace-pre-wrap">{x.answer}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </section>
  );
}

/** Phones: after the dialer, the same result, status, temperature and note as the desktop call screen. */
function CallOutcomeDialog({ open, call, leadId, leadName }: { open: boolean; call: WrapUpCall; leadId: string; leadName: string }) {
  const [value, setValue] = useState<WrapUp>(EMPTY_WRAP_UP);
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) { setValue(EMPTY_WRAP_UP); setConfirmSave(false); setConfirmSkip(false); }
  }
  const lead = useCallLead(leadId, open);
  const live = useTalkSeconds(call.talkStartedAt);
  const talkSeconds = live ?? call.durationSeconds;
  const dirty = isWrapUpDirty(value);
  const askSave = () => {
    if (!value.outcome) return void toast.error("Choose how the call went.");
    void call.halt();
    setConfirmSave(true);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && !confirmSave && (dirty ? setConfirmSkip(true) : call.skip())}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>How did the call go?</DialogTitle>
            <DialogDescription>The call to {leadName} is already in the timeline. Add the result so the team knows what happened.</DialogDescription>
          </DialogHeader>
          <CallWrapUpFields value={value} onChange={setValue} lead={lead.data} talkSeconds={talkSeconds} compact />
          <DialogFooter>
            <Button variant="outline" onClick={() => (dirty ? setConfirmSkip(true) : call.skip())}>Skip</Button>
            <Button onClick={askSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WrapUpConfirm
        open={open && confirmSave}
        onOpenChange={setConfirmSave}
        changes={changesOf(value, lead.data)}
        lead={lead.data}
        talkSeconds={talkSeconds}
        onConfirm={() => call.save(value, lead.data)}
      />
      <ConfirmDialog
        open={open && confirmSkip}
        onOpenChange={setConfirmSkip}
        title="Discard what you entered?"
        description="The call stays in the timeline with its talk time, but the result, status, temperature and note you picked are not saved."
        confirmLabel="Discard"
        destructive
        onConfirm={async () => call.skip()}
      />
    </>
  );
}

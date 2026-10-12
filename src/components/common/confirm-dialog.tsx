"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

/** A confirm step. Pass `trigger`, or control it with `open` / `onOpenChange` (e.g. from a right-click menu). */
export function ConfirmDialog({
  trigger, title, description, confirmLabel = "Confirm", destructive, onConfirm, open: controlled, onOpenChange,
}: {
  trigger?: React.ReactNode; title: string; description: React.ReactNode; confirmLabel?: string; destructive?: boolean;
  onConfirm: () => Promise<boolean | void>; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (o: boolean) => { setOwn(o); onOpenChange?.(o); };
  const [pending, start] = useTransition();
  return (
    <AlertDialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
      {trigger ? <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger> : null}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={() =>
              start(async () => {
                const keepOpen = (await onConfirm()) === false;
                if (!keepOpen) setOpen(false);
              })
            }
          >
            {pending && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

"use client";

import { useActionState, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { signIn } from "@/server/actions/auth";

const fieldClass =
  "h-[52px] w-full rounded-full border border-input bg-background px-5 text-[15px] outline-none transition-colors placeholder:text-muted-foreground focus:border-foreground focus:ring-1 focus:ring-foreground";

export function LoginForm() {
  const params = useSearchParams();
  const [state, action, pending] = useActionState(signIn, null);
  const [show, setShow] = useState(false);
  const message = state && !state.ok ? state.error : params.get("error") === "inactive" ? "Your account is deactivated. Contact an admin." : null;
  // Each failed attempt returns a new state object, so every attempt gets its own toast.
  useEffect(() => {
    if (state && !state.ok) toast.error(state.error);
  }, [state]);
  useEffect(() => {
    if (params.get("error") === "inactive") toast.error("Your account is deactivated. Contact an admin.", { id: "login-inactive" });
  }, [params]);

  return (
    <form action={action} className="space-y-3" noValidate>
      <input type="hidden" name="next" value={params.get("next") ?? ""} />
      <label className="sr-only" htmlFor="username">Username</label>
      <input id="username" name="username" placeholder="Username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus className={fieldClass} aria-invalid={!!message} />
      <div className="relative">
        <label className="sr-only" htmlFor="password">Password</label>
        <input id="password" name="password" type={show ? "text" : "password"} placeholder="Password" autoComplete="current-password" required className={`${fieldClass} pr-12`} aria-invalid={!!message} />
        <button type="button" onClick={() => setShow((s) => !s)} className="absolute top-1/2 right-4 -translate-y-1/2 text-muted-foreground hover:text-foreground" aria-label={show ? "Hide password" : "Show password"}>
          {show ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
      </div>
      <button type="submit" disabled={pending} className="flex h-[52px] w-full items-center justify-center gap-2 rounded-full bg-primary text-[15px] font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-60">
        {pending && <Loader2 className="size-4 animate-spin" />}
        Continue
      </button>
      <p className="pt-3 text-center text-[13px] text-muted-foreground">Forgot your password? Ask an admin to reset it.</p>
    </form>
  );
}

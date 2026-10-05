"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { signIn } from "@/server/actions/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export function LoginForm() {
  const params = useSearchParams();
  const [state, action, pending] = useActionState(signIn, null);
  const inactive = params.get("error") === "inactive";

  return (
    <Card>
      <CardContent>
        <form action={action} className="space-y-4" noValidate>
          <input type="hidden" name="next" value={params.get("next") ?? ""} />
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="username">Username</FieldLabel>
              <Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required autoFocus />
            </Field>
            <Field>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </Field>
          </FieldGroup>
          {(state && !state.ok) || inactive ? (
            <FieldError role="alert">{state && !state.ok ? state.error : "Your account is deactivated. Contact an admin."}</FieldError>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Sign in
          </Button>
          <p className="text-center text-xs text-muted-foreground">Forgot your password? Ask an admin to reset it.</p>
        </form>
      </CardContent>
    </Card>
  );
}

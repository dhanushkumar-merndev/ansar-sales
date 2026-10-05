import "server-only";
import type { z } from "zod";
import { AuthorizationError, authorizeAction } from "@/lib/auth";
import type { AppRole } from "@/lib/constants";
import { validationError, type ActionResult } from "@/lib/errors";

type Ctx = Awaited<ReturnType<typeof authorizeAction>>;

/** Validates input with Zod, authorizes the active user's role, then runs the mutation with the user's RLS client. */
export async function runAction<S extends z.ZodType, T>(
  roles: AppRole[],
  schema: S,
  input: unknown,
  fn: (data: z.output<S>, ctx: Ctx) => Promise<ActionResult<T>>,
): Promise<ActionResult<T>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return validationError(parsed.error.issues);
  try {
    const ctx = await authorizeAction(roles);
    return await fn(parsed.data, ctx);
  } catch (e) {
    if (e instanceof AuthorizationError) return { ok: false, error: "You don't have permission to do that.", code: "forbidden" };
    console.error("action failed", e instanceof Error ? e.message : "unknown");
    return { ok: false, error: "Something went wrong. Please try again.", code: "unknown" };
  }
}

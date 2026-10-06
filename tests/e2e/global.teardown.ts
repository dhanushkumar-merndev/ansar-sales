import { test as teardown } from "@playwright/test";
import { env } from "./support/env";
import { cleanupE2EData } from "./support/supabase";

teardown("delete e2e users and everything they created", async () => {
  teardown.setTimeout(180_000);
  if (env.keepData) {
    console.log("[e2e] E2E_KEEP_DATA=1: leaving e2e_* users and their data in place.");
    return;
  }
  const removed = await cleanupE2EData();
  console.log("[e2e] cleanup:", removed);
});

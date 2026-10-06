import { test as base, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test";
import { type AccountKey, type RunInfo, readRun, storageState } from "./accounts";
import { type Db, userClient } from "./supabase";
import { hideDevOverlay } from "./ui";

type Fixtures = {
  /** Run info written by the setup project: account ids and the shared password. */
  run: RunInfo;
  /** A new page signed in as one of the test accounts (separate browser context per call). */
  as: (key: AccountKey, options?: BrowserContextOptions) => Promise<Page>;
  /** REST client acting as one of the test accounts' browser sessions (RLS applies). */
  api: (key: AccountKey) => Db;
};

export const test = base.extend<Fixtures>({
  context: async ({ context }, provide) => {
    await hideDevOverlay(context);
    await provide(context);
  },
  run: async ({}, provide) => {
    await provide(readRun());
  },
  as: async ({ browser, baseURL, timezoneId, locale, viewport }, provide) => {
    const contexts: BrowserContext[] = [];
    await provide(async (key, options) => {
      const context = await browser.newContext({ baseURL, timezoneId, locale, viewport, ...options, storageState: storageState(key) });
      contexts.push(context);
      await hideDevOverlay(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((c) => c.close()));
  },
  api: async ({}, provide) => {
    await provide((key) => userClient(key));
  },
});

export { expect } from "@playwright/test";

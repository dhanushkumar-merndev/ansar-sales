import { randomInt } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { env } from "./support/env";
import { serviceClient } from "./support/supabase";
import { toast } from "./support/ui";

const WEBHOOK = "/api/telegram/webhook";
// Far outside real Telegram user ids, so the bot's reply can never reach a person.
const fakeChatId = () => 9_000_000_000_000 + randomInt(1, 999_999);

const startUpdate = (token: string, chatId: number) => ({
  update_id: randomInt(1, 2 ** 31),
  message: {
    message_id: 1,
    date: Math.floor(Date.now() / 1000),
    text: `/start ${token}`,
    chat: { id: chatId, type: "private" },
    from: { id: chatId, is_bot: false, first_name: "E2E", username: "e2e_tg_user" },
  },
});

const post = (request: APIRequestContext, data: unknown, secret?: string) =>
  request.post(WEBHOOK, { data, headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} });

test.describe("Telegram linking", () => {
  test("TG-01/02 webhook rejects missing or wrong secrets and non-POST methods", async ({ request }) => {
    test.skip(!env.webhookSecret, "TELEGRAM_WEBHOOK_SECRET not configured");
    expect((await post(request, startUpdate("a".repeat(64), fakeChatId()))).status()).toBe(401);
    expect((await post(request, startUpdate("a".repeat(64), fakeChatId()), "wrong-secret")).status()).toBe(401);
    expect((await request.get(WEBHOOK)).status()).toBe(405);
  });

  test("TG-03/04/06 connect with a single-use token, reject reuse, then disconnect", async ({ as, request, run }) => {
    test.skip(!env.webhookSecret || !env.botUsername, "Telegram bot not configured");
    const page = await as("account");
    await page.context().route("https://t.me/**", (route) => route.abort());
    page.context().on("page", (p) => void p.close());

    await page.goto("/settings");
    await expect(page.getByText("Not connected")).toBeVisible();
    await page.getByRole("button", { name: "Connect Telegram" }).click();
    const href = await page.getByRole("link", { name: /Open again/ }).getAttribute("href");
    const token = new URL(href!).searchParams.get("start")!;
    expect(token).toMatch(/^[a-f0-9]{64}$/);

    const chatId = fakeChatId();
    expect((await post(request, startUpdate(token, chatId), env.webhookSecret!)).status()).toBe(200);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("@e2e_tg_user")).toBeVisible();

    // A replayed token must not re-bind the account to another chat.
    expect((await post(request, startUpdate(token, fakeChatId()), env.webhookSecret!)).status()).toBe(200);
    const { data } = await serviceClient().from("telegram_connections").select("chat_id, status").eq("user_id", run.ids.account).single();
    expect(data).toEqual({ chat_id: chatId, status: "connected" });

    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect" }).click();
    await expect(toast(page, "Telegram disconnected")).toBeVisible();
    await expect(page.getByText("Not connected")).toBeVisible();
  });
});

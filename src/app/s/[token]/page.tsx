import type { Metadata } from "next";
import { after } from "next/server";
import { headers } from "next/headers";
import { cache } from "react";
import { BRAND_NAME } from "@/components/app/brand";
import { SharedDocuments, type ShareBrand, type SharedDocumentsData } from "@/components/share/shared-documents";
import { companyLogoUrl } from "@/lib/companies";
import { publicEnv } from "@/lib/env";
import { describeDevice, PREVIEW_BOT_RE } from "@/lib/device";
import { createAnonClient } from "@/lib/supabase/anon";
import { notifyShareOpened } from "@/server/share-notify";

const TOKEN_RE = /^[a-f0-9]{64}$/;

/** The lead's company, for the header and the link preview. Falls back to the platform brand. */
const loadBrand = cache(async (token: string): Promise<ShareBrand> => {
  if (TOKEN_RE.test(token)) {
    const { data } = await createAnonClient().rpc("share_brand", { p_token: token });
    const b = data as { name: string; brand_highlight: string | null; logo_path: string | null } | null;
    if (b) return { name: b.name, highlight: b.brand_highlight, logoUrl: companyLogoUrl(b.logo_path) };
  }
  return { name: BRAND_NAME, highlight: null, logoUrl: null };
});

export async function generateMetadata({ params }: PageProps<"/s/[token]">): Promise<Metadata> {
  const { name } = await loadBrand((await params).token);
  return {
    // WhatsApp needs absolute preview-image URLs.
    metadataBase: publicEnv.appUrl ? new URL(publicEnv.appUrl) : undefined,
    title: { absolute: `Documents from ${name}` },
    description: `Brochures and documents shared with you by ${name}.`,
    openGraph: { title: `Documents from ${name}`, description: "Tap to view and download.", images: ["/android-chrome-512x512.png"] },
    referrer: "no-referrer",
  };
}

type Share = SharedDocumentsData & { notify_share_id: string | null };

async function loadShare(token: string): Promise<Share | null> {
  if (!TOKEN_RE.test(token)) return null;
  const ua = (await headers()).get("user-agent") ?? "";
  const { data, error } = await createAnonClient().rpc("open_lead_share", {
    p_token: token,
    p_count_view: !PREVIEW_BOT_RE.test(ua),
    p_device: describeDevice(ua) ?? undefined,
  });
  if (error) return null;
  const share = data as unknown as Share | null;
  // Telegram the owner after the response is sent, so the customer's page isn't slowed.
  const notifyId = share?.notify_share_id;
  if (notifyId) after(() => notifyShareOpened(notifyId));
  return share;
}

export default async function SharePage({ params }: PageProps<"/s/[token]">) {
  const { token } = await params;
  const [share, brand] = await Promise.all([loadShare(token), loadBrand(token)]);
  return <SharedDocuments brand={brand} share={share} fileHref={(f) => `/s/${token}/f/${f.id}`} />;
}

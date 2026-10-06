// Short, human device label from a user-agent ("Android · Chrome"). No identifiers are kept.
export function describeDevice(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const os = /iPad/.test(ua) ? "iPad"
    : /iPhone|iPod/.test(ua) ? "iPhone"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /CrOS/.test(ua) ? "Chromebook"
    : /Linux/.test(ua) ? "Linux"
    : null;
  const app = /WhatsApp/i.test(ua) ? "WhatsApp"
    : /SamsungBrowser/.test(ua) ? "Samsung Internet"
    : /Edg\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
    : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
    : /CriOS|Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : null;
  return [os, app].filter(Boolean).join(" · ") || null;
}

// Link-preview fetchers (WhatsApp, Telegram, …) must not count as the customer.
export const PREVIEW_BOT_RE = /^whatsapp\/|facebookexternalhit|facebot|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|bot\b|crawler|spider|preview/i;

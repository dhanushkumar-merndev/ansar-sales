"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/** The CRM is dark-only (ChatGPT-style). Theme switching is intentionally disabled. */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider attribute="class" forcedTheme="dark" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}

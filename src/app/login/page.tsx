import type { Metadata } from "next";
import { Suspense } from "react";
import { BrandMark, BrandName } from "@/components/app/brand";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <div className="flex flex-1 items-center justify-center px-4 pb-24">
        <div className="w-full max-w-[360px]">
          <div className="mb-8 flex flex-col items-center text-center">
            <BrandMark size={56} className="mb-3" />
            <BrandName className="mb-5 text-sm font-semibold tracking-wide" />
            <h1 className="text-[28px] font-semibold tracking-tight">Welcome back</h1>
            <p className="mt-2 text-[15px] text-muted-foreground">Log in with the username your admin gave you.</p>
          </div>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
      <footer className="pb-6 text-center text-xs text-muted-foreground">Internal use only</footer>
    </main>
  );
}

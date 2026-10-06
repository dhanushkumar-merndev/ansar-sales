"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CompanyBrand } from "@/lib/companies";
import { switchCompany } from "@/server/actions/companies";

/**
 * Shown to the super admin when a link points into another company: switches to it and
 * reloads the page. A company switch is a full context change (like signing in again), so
 * a hard reload is the simplest way to drop every cached list of the previous company.
 */
export function OpenInCompany({ company }: { company: CompanyBrand }) {
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setError(null);
    const res = await switchCompany({ id: company.id });
    if (res.ok) window.location.reload();
    else setError(res.error);
  };

  useEffect(() => {
    let cancelled = false;
    void switchCompany({ id: company.id }).then((res) => {
      if (cancelled) return;
      if (res.ok) window.location.reload();
      else setError(res.error);
    });
    return () => { cancelled = true; };
  }, [company.id]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-24 text-center">
      {error ? (
        <>
          <p className="text-sm text-muted-foreground">This lead belongs to {company.name}. {error}</p>
          <Button onClick={go}>Switch to {company.name}</Button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Opening in {company.name}…
        </p>
      )}
    </div>
  );
}

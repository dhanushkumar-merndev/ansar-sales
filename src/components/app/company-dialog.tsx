"use client";

import { useRef, useState, useTransition } from "react";
import { ImageUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { BrandMark, BrandName } from "@/components/app/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { COMPANY_LOGO_BUCKET, companyLogoUrl } from "@/lib/companies";
import { createClient } from "@/lib/supabase/client";
import { createCompany, updateCompany } from "@/server/actions/companies";

const LOGO_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const MAX_LOGO_BYTES = 1024 * 1024;

export type EditableCompany = { id: string; name: string; brand_highlight: string | null; logo_path: string | null };

/** Create a company, or edit one's name, highlighted word and logo (super admin). */
export function CompanyDialog({ open, onOpenChange, company, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  company?: EditableCompany | null;
  onSaved?: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open ? <CompanyForm key={company?.id ?? "new"} company={company ?? null} onDone={(id) => { onOpenChange(false); onSaved?.(id); }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CompanyForm({ company, onDone }: { company: EditableCompany | null; onDone: (id: string) => void }) {
  const [name, setName] = useState(company?.name ?? "");
  const [highlight, setHighlight] = useState(company?.brand_highlight ?? "");
  const [logoPath, setLogoPath] = useState<string | null>(company?.logo_path ?? null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const highlightMissing = highlight.trim() !== "" && !name.toLowerCase().includes(highlight.trim().toLowerCase());

  async function uploadLogo(file: File) {
    if (!company) return;
    const ext = LOGO_TYPES[file.type];
    if (!ext) return setError("Use a PNG, JPEG or WEBP image.");
    if (file.size > MAX_LOGO_BYTES) return setError("The logo can be at most 1 MB.");
    setError(null);
    setUploading(true);
    const path = `${company.id}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await createClient().storage.from(COMPANY_LOGO_BUCKET).upload(path, file, { contentType: file.type });
    setUploading(false);
    if (uploadError) return setError("Couldn't upload the logo. Please retry.");
    setLogoPath(path);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (highlightMissing) return setError("The highlighted word must be part of the name.");
    setError(null);
    startTransition(async () => {
      if (!company) {
        const res = await createCompany({ name, brandHighlight: highlight });
        if (!res.ok) return setError(res.error);
        toast.success(`${name.trim()} created`);
        onDone(res.data.id);
        return;
      }
      const res = await updateCompany({
        id: company.id,
        name,
        brandHighlight: highlight,
        ...(logoPath && logoPath !== company.logo_path ? { logoPath } : {}),
        ...(!logoPath && company.logo_path ? { clearLogo: true } : {}),
      });
      if (!res.ok) return setError(res.error);
      toast.success("Company saved");
      onDone(company.id);
    });
  }

  return (
    <form onSubmit={submit} className="grid gap-5">
      <DialogHeader>
        <DialogTitle>{company ? "Edit company" : "Add company"}</DialogTitle>
        <DialogDescription>
          {company ? "Name and branding shown in the sidebar and on shared document pages." : "A new company starts empty: its own leads, users, library and finance."}
        </DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="company-name">Name</FieldLabel>
          <Input id="company-name" value={name} maxLength={80} required autoFocus placeholder="e.g. Star Gardens" onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field data-invalid={highlightMissing}>
          <FieldLabel htmlFor="company-highlight">Word in red <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
          <Input id="company-highlight" value={highlight} maxLength={40} placeholder="e.g. Gardens" onChange={(e) => setHighlight(e.target.value)} aria-invalid={highlightMissing} />
          <FieldDescription>
            Preview: <BrandName name={name.trim() || "Company name"} highlight={highlight.trim() || null} className="font-medium text-foreground" />
          </FieldDescription>
        </Field>
        {company ? (
          <Field>
            <FieldLabel>Logo <span className="font-normal text-muted-foreground">(optional)</span></FieldLabel>
            <div className="flex items-center gap-3">
              <BrandMark size={40} logoUrl={companyLogoUrl(logoPath)} />
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void uploadLogo(f); }} />
              <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="animate-spin" /> : <ImageUp />} {logoPath ? "Replace" : "Upload"}
              </Button>
              {logoPath ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => setLogoPath(null)}><Trash2 /> Remove</Button>
              ) : null}
            </div>
            <FieldDescription>Square PNG, JPEG or WEBP, up to 1 MB. Without one, the default star logo is used.</FieldDescription>
          </Field>
        ) : null}
      </FieldGroup>
      {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
      <DialogFooter>
        <Button type="submit" disabled={pending || uploading || !name.trim()}>
          {pending ? <Loader2 className="animate-spin" /> : null} {company ? "Save" : "Create company"}
        </Button>
      </DialogFooter>
    </form>
  );
}

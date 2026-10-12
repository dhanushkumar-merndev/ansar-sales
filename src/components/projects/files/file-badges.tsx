import { Box, File, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, PencilRuler } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FILE_STATUS_LABELS, type FileVersionStatus } from "@/lib/projects";
import { STAGE_BADGE, type StageColor } from "@/lib/stages";
import { cn } from "@/lib/utils";

const COLOR: Record<FileVersionStatus, StageColor> = {
  draft: "slate", submitted: "violet", approved: "sky", client_approved: "emerald", changes_requested: "orange", superseded: "slate",
};

export function FileStatusBadge({ status, className }: { status: FileVersionStatus; className?: string }) {
  return <Badge variant="outline" className={cn("font-medium", STAGE_BADGE[COLOR[status]], status === "superseded" && "opacity-60", className)}>{FILE_STATUS_LABELS[status]}</Badge>;
}

const ICONS = { image: FileImage, pdf: FileText, cad: PencilRuler, sketchup: Box, video: FileVideo, office: FileSpreadsheet, archive: FileArchive, other: File } as const;

export function FileKindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[kind as keyof typeof ICONS] ?? File;
  return <Icon className={cn("size-4 shrink-0 text-muted-foreground", className)} aria-hidden />;
}

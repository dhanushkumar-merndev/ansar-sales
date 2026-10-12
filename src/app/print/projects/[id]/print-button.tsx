"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return <Button onClick={() => window.print()} className="bg-black text-white hover:bg-neutral-800"><Printer /> Print / Save PDF</Button>;
}

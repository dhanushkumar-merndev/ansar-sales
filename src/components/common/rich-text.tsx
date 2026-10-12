"use client";

import { useEffect } from "react";
import { EditorContent, useEditor, useEditorState, type Editor, type JSONContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Color, FontSize, TextStyle } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";
import {
  Bold, Heading2, Highlighter, Italic, List, ListOrdered, Redo2, Strikethrough, Underline as UnderlineIcon, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

export type RichDoc = JSONContent & { type: "doc" };

const extensions = [
  StarterKit.configure({ heading: { levels: [2, 3] }, link: false }),
  TextStyle,
  Color,
  FontSize,
  Highlight.configure({ multicolor: false }),
];

const SIZES = [{ value: "default", label: "Normal" }, { value: "12px", label: "Small" }, { value: "18px", label: "Large" }, { value: "22px", label: "Huge" }];
const COLORS = [
  { value: "default", label: "Default", hex: "" }, { value: "#f87171", label: "Red", hex: "#f87171" }, { value: "#fbbf24", label: "Amber", hex: "#fbbf24" },
  { value: "#34d399", label: "Green", hex: "#34d399" }, { value: "#60a5fa", label: "Blue", hex: "#60a5fa" }, { value: "#a78bfa", label: "Violet", hex: "#a78bfa" },
];

const PROSE = "text-sm leading-relaxed [&_h2]:mt-3 [&_h2]:mb-1 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1 [&_h3]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_mark]:rounded-sm [&_mark]:bg-amber-300/30 [&_mark]:px-0.5 [&_mark]:text-inherit";

/** Word-like notes editor (bold, italic, underline, size, colour, lists, headings). Stores Tiptap JSON, never HTML. */
export function RichTextEditor({ value, onChange, placeholder, disabled, ariaLabel = "Notes" }: {
  value: RichDoc | null; onChange: (doc: RichDoc | null) => void; placeholder?: string; disabled?: boolean; ariaLabel?: string;
}) {
  const editor = useEditor({
    extensions,
    content: value ?? "",
    editable: !disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: cn("min-h-28 max-h-80 overflow-y-auto px-3 py-2 outline-none", PROSE),
        "aria-label": ariaLabel,
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? null : (e.getJSON() as RichDoc)),
  });
  useEffect(() => { editor?.setEditable(!disabled); }, [editor, disabled]);

  return (
    <div className={cn("rounded-md border bg-transparent focus-within:ring-2 focus-within:ring-ring/50", disabled && "opacity-70")}>
      {editor && !disabled ? <Toolbar editor={editor} /> : null}
      <div className="relative">
        <EditorContent editor={editor} />
        {editor?.isEmpty && placeholder ? <div className="pointer-events-none absolute top-2 left-3 text-sm text-muted-foreground">{placeholder}</div> : null}
      </div>
    </div>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive("bold"), italic: e.isActive("italic"), underline: e.isActive("underline"), strike: e.isActive("strike"),
      h2: e.isActive("heading", { level: 2 }), bullet: e.isActive("bulletList"), ordered: e.isActive("orderedList"), mark: e.isActive("highlight"),
      size: (e.getAttributes("textStyle").fontSize as string | undefined) ?? "default",
      color: (e.getAttributes("textStyle").color as string | undefined) ?? "default",
      undo: e.can().undo(), redo: e.can().redo(),
    }),
  });
  const btn = (active: boolean, label: string, onClick: () => void, Icon: typeof Bold, disabled = false) => (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={label} aria-pressed={active} title={label} disabled={disabled}
      className={cn(active && "bg-accent text-accent-foreground")} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      <Icon />
    </Button>
  );
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b px-1 py-1" role="toolbar" aria-label="Formatting">
      {btn(s.bold, "Bold", () => editor.chain().focus().toggleBold().run(), Bold)}
      {btn(s.italic, "Italic", () => editor.chain().focus().toggleItalic().run(), Italic)}
      {btn(s.underline, "Underline", () => editor.chain().focus().toggleUnderline().run(), UnderlineIcon)}
      {btn(s.strike, "Strikethrough", () => editor.chain().focus().toggleStrike().run(), Strikethrough)}
      {btn(s.mark, "Highlight", () => editor.chain().focus().toggleHighlight().run(), Highlighter)}
      <span className="mx-1 h-5 w-px bg-border" />
      {btn(s.h2, "Heading", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), Heading2)}
      {btn(s.bullet, "Bullet list", () => editor.chain().focus().toggleBulletList().run(), List)}
      {btn(s.ordered, "Numbered list", () => editor.chain().focus().toggleOrderedList().run(), ListOrdered)}
      <span className="mx-1 h-5 w-px bg-border" />
      <Select value={s.size} onValueChange={(v) => (v === "default" ? editor.chain().focus().unsetFontSize().run() : editor.chain().focus().setFontSize(v).run())}>
        <SelectTrigger size="sm" className="h-7 w-[92px] text-xs" aria-label="Text size"><SelectValue /></SelectTrigger>
        <SelectContent>{SIZES.map((x) => <SelectItem key={x.value} value={x.value}>{x.label}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={s.color} onValueChange={(v) => (v === "default" ? editor.chain().focus().unsetColor().run() : editor.chain().focus().setColor(v).run())}>
        <SelectTrigger size="sm" className="h-7 w-[100px] text-xs" aria-label="Text colour"><SelectValue /></SelectTrigger>
        <SelectContent>
          {COLORS.map((x) => (
            <SelectItem key={x.value} value={x.value}>
              <span className="inline-flex items-center gap-2">{x.hex ? <span className="size-3 rounded-full" style={{ background: x.hex }} /> : null}{x.label}</span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="ml-auto" />
      {btn(false, "Undo", () => editor.chain().focus().undo().run(), Undo2, !s.undo)}
      {btn(false, "Redo", () => editor.chain().focus().redo().run(), Redo2, !s.redo)}
    </div>
  );
}

/** Read-only rendering of saved notes. */
export function RichTextView({ value, className }: { value: RichDoc | null | undefined; className?: string }) {
  const editor = useEditor({ extensions, content: value ?? "", editable: false, immediatelyRender: false, editorProps: { attributes: { class: PROSE } } });
  useEffect(() => {
    if (editor && value && JSON.stringify(editor.getJSON()) !== JSON.stringify(value)) editor.commands.setContent(value);
  }, [editor, value]);
  if (!value) return null;
  return <div className={className}><EditorContent editor={editor} /></div>;
}

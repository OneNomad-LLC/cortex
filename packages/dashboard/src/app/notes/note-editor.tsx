"use client";

import * as React from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  List,
  ListOrdered,
  Quote,
  Heading1,
  Heading2,
  Heading3,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NoteEditorProps {
  initialMarkdown: string;
  onChange: (markdown: string) => void;
}

export function NoteEditor({
  initialMarkdown,
  onChange,
}: NoteEditorProps): React.JSX.Element {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Markdown.configure({
        // Stable serialization — what the user sees is what we save.
        html: false,
        breaks: true,
        linkify: true,
        transformPastedText: true,
      }),
    ],
    content: initialMarkdown,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      // tiptap-markdown attaches storage.markdown.getMarkdown() at runtime.
      // TypeScript doesn't know about the runtime augmentation, so cast.
      const storage = editor.storage as unknown as Record<
        string,
        { getMarkdown?: () => string } | undefined
      >;
      const md = storage.markdown?.getMarkdown?.();
      onChange(md ?? editor.getText());
    },
    editorProps: {
      attributes: {
        class:
          "min-h-[300px] max-w-none prose prose-sm dark:prose-invert focus:outline-none",
      },
    },
  });

  if (!editor) {
    return (
      <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        Loading editor…
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card">
      <Toolbar editor={editor} />
      <div className="p-4">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

interface ToolbarEditor {
  chain(): {
    focus(): {
      toggleBold(): { run(): void };
      toggleItalic(): { run(): void };
      toggleStrike(): { run(): void };
      toggleCode(): { run(): void };
      toggleHeading(opts: { level: 1 | 2 | 3 }): { run(): void };
      toggleBulletList(): { run(): void };
      toggleOrderedList(): { run(): void };
      toggleBlockquote(): { run(): void };
    };
  };
  isActive(name: string, attrs?: Record<string, unknown>): boolean;
}

function Toolbar({ editor }: { editor: ToolbarEditor }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5">
      <ToolbarButton
        active={editor.isActive("bold")}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold"
      >
        <Bold className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("italic")}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic"
      >
        <Italic className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("strike")}
        onClick={() => editor.chain().focus().toggleStrike().run()}
        label="Strikethrough"
      >
        <Strikethrough className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("code")}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Inline code"
      >
        <Code className="h-3.5 w-3.5" />
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        label="Heading 1"
      >
        <Heading1 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        label="Heading 2"
      >
        <Heading2 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("heading", { level: 3 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        label="Heading 3"
      >
        <Heading3 className="h-3.5 w-3.5" />
      </ToolbarButton>
      <Divider />
      <ToolbarButton
        active={editor.isActive("bulletList")}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bullet list"
      >
        <List className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("orderedList")}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
      >
        <ListOrdered className="h-3.5 w-3.5" />
      </ToolbarButton>
      <ToolbarButton
        active={editor.isActive("blockquote")}
        onClick={() => editor.chain().focus().toggleBlockquote().run()}
        label="Quote"
      >
        <Quote className="h-3.5 w-3.5" />
      </ToolbarButton>
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "h-7 w-7 p-0",
        active && "bg-accent text-accent-foreground",
      )}
    >
      {children}
    </Button>
  );
}

function Divider(): React.JSX.Element {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden />;
}

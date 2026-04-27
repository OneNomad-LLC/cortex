import { NotesPanel } from "./notes-panel";

export const dynamic = "force-dynamic";

export default function NotesPage(): React.JSX.Element {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight">Notes</h1>
        <p className="text-sm text-muted-foreground">
          Markdown notes saved to your Obsidian vault under{" "}
          <code className="font-mono text-xs">cortex-notes/</code>. Edit here,
          read anywhere — same files. Indexed by the obsidian adapter for
          search.
        </p>
      </header>
      <NotesPanel />
    </div>
  );
}

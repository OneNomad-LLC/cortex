import { ObsidianViewer } from "../../obsidian-viewer";

export const dynamic = "force-dynamic";

export default async function ObsidianNotePage({
  params,
}: {
  params: Promise<{ path: string[] }>;
}): Promise<React.JSX.Element> {
  const { path } = await params;
  // Note id in the listing is the relative POSIX path with `.md`
  // stripped; reattach it before calling note_get. Decode each
  // segment because the listing's <Link> URL-encodes them so
  // weird characters (spaces, parentheses) survive routing.
  const relativePath = `${path.map(decodeURIComponent).join("/")}.md`;
  return <ObsidianViewer relativePath={relativePath} />;
}

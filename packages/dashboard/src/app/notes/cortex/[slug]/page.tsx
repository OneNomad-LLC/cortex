import { CortexNoteEditor } from "./editor";

export const dynamic = "force-dynamic";

export default async function EditCortexNotePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.JSX.Element> {
  const { slug } = await params;
  return <CortexNoteEditor slug={slug} />;
}

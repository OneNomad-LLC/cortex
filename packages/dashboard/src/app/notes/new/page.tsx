import { NoteEditForm } from "../note-edit-form";

export const dynamic = "force-dynamic";

export default function NewNotePage(): React.JSX.Element {
  return <NoteEditForm mode="create" />;
}

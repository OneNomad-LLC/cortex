import { PrioritiesWidget } from "@/widgets/priorities";

export const dynamic = "force-dynamic";

export default function Home(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Cortex</h1>
        <p className="text-sm text-neutral-500">
          Your work-knowledge dashboard. Local to this machine.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <PrioritiesWidget limit={20} />
        {/* Additional widgets land here as they ship. See ADR-015. */}
      </div>
    </main>
  );
}

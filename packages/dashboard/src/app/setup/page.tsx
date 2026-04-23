import { SetupFlow } from "@/widgets/setup-flow";

export const dynamic = "force-dynamic";

export default function SetupPage(): React.JSX.Element {
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Cortex setup</h1>
        <p className="text-sm text-neutral-500">
          Point-and-click configuration. Finish the steps and your
          dashboard goes live — no more terminal required.
        </p>
      </header>
      <SetupFlow />
    </main>
  );
}

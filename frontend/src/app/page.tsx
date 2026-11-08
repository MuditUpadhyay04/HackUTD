import { Suspense } from "react";
import { Workspace } from "@/components/console/workspace";
import { listDatasets, defaultDataset } from "@/lib/api";
import { store as ingestStore } from "@/lib/live/ingest-store";

export default function Page({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<Loading />}>
      <ConsoleForRequest searchParams={searchParams} />
    </Suspense>
  );
}

async function ConsoleForRequest({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const sp = await searchParams;
  const datasets = await listDatasets();
  if (datasets.length === 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-24">
        <h1 className="font-display text-3xl font-semibold">No datasets found</h1>
        <p className="mt-3 text-muted-foreground">
          Put a folder with network.json, ops.json and telemetry.csv in the data folder, or set DATA_ROOT to where they live.
        </p>
      </main>
    );
  }
  const requested = typeof sp.dataset === "string" ? sp.dataset : undefined;
  const dataset = datasets.find((d) => d.id === requested) ?? defaultDataset(datasets)!;
  const at = typeof sp.at === "string" && sp.at.trim() !== "" ? Number(sp.at) : undefined;
  const boardNow =
    process.env.BOARD_INGEST === "1" && at == null && ingestStore.latestTs != null &&
    ingestStore.latestTs >= dataset.startUnix && ingestStore.latestTs <= dataset.nowUnix
      ? ingestStore.latestTs
      : undefined;
  return (
    <>
      <Workspace dataset={dataset} at={at} boardNow={boardNow} />
    </>
  );
}

function Loading() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[1440px] items-center px-6">
      <p className="font-display text-2xl text-muted-foreground">Reading the network…</p>
    </main>
  );
}
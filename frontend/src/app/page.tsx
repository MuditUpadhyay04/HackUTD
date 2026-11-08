import { Suspense } from "react";
import { connection } from "next/server";
import { Console } from "@/components/console/console";
import { LiveRefresh } from "@/components/console/live-refresh";
import { getSnapshot, listDatasets } from "@/lib/engine";
import { getBoard } from "@/lib/live/board";
import { store as ingestStore } from "@/lib/live/ingest-store";
import { defaultDataset } from "@/lib/format";

export default function Page({ searchParams }: PageProps<"/">) {
  return (
    <Suspense fallback={<Loading />}>
      <ConsoleForRequest searchParams={searchParams} />
    </Suspense>
  );
}

async function ConsoleForRequest({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  // Board status depends on wall-clock freshness of the live feed, so this page is rendered per request.
  await connection();
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
  // With live board data, "now" is the newest telemetry timestamp the board has sent (team rule), not the end of the file.
  const boardNow =
    process.env.BOARD_INGEST === "1" && at == null && ingestStore.latestTs != null &&
    ingestStore.latestTs >= dataset.startUnix && ingestStore.latestTs <= dataset.nowUnix
      ? ingestStore.latestTs
      : undefined;
  const local = await getSnapshot(dataset.id, Number.isFinite(at) ? at : boardNow);
  // Board data (FPGA via the team server) is layered on top of the local engine, never instead of it.
  const snapshot = { ...local, board: await getBoard(local) };
  return (
    <>
      <Console key={snapshot.dataset.id} snapshot={snapshot} datasets={datasets} followsBoard={boardNow != null} />
      {process.env.BOARD_INGEST === "1" && at == null && <LiveRefresh seconds={3} />}
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

import { Suspense } from "react";
import { Workspace } from "@/components/console/workspace";
import { LiveRefresh } from "@/components/console/live-refresh";
import { store as ingestStore } from "@/lib/live/ingest-store";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type ClassicProps = { searchParams: SearchParams };

export default function Page({ searchParams }: ClassicProps) {
  return (
    <Suspense fallback={<Loading />}>
      <ConsoleForRequest searchParams={searchParams} />
    </Suspense>
  );
}

async function ConsoleForRequest({ searchParams }: ClassicProps) {
  const sp = await searchParams;
  // No server-side API call: the server-side Eden base has no origin (it would hit port 80). The client Workspace
  // loads the datasets itself and reads `dataset` and `at` from the URL.
  const atRaw = typeof sp.at === "string" && sp.at.trim() !== "" ? Number(sp.at) : undefined;
  const at = atRaw != null && Number.isFinite(atRaw) ? atRaw : undefined;
  const live = process.env.BOARD_INGEST === "1" && at == null;
  const boardNow = live && ingestStore.latestTs != null ? ingestStore.latestTs : undefined;
  return (
    <>
      <Workspace at={at} boardNow={boardNow} />
      {live && <LiveRefresh seconds={3} />}
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
import { Suspense } from "react";
import { Workspace } from "@/components/console/workspace";

export default function Page() {
  return <Suspense fallback={<main className="p-8">Loading workspace…</main>}><Workspace /></Suspense>;
}

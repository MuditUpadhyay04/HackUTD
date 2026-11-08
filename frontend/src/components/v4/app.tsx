"use client";
import Link from "next/link";
import { PlayheadProvider } from "@/lib/v4/store";
import { useRun } from "@/lib/v4/use-run";
import { Shell } from "./shell";
import { V4Loading } from "./loading";

export function V4App() {
  const run = useRun();
  const { snapshot } = run;
  if (!snapshot) {
    if (run.error) {
      return (
        <div className="v4">
          <div className="v4-center" role="alert">
            <div className="label" style={{ color: "var(--red)" }}>Run failed</div>
            <div className="mono" style={{ maxWidth: 560, whiteSpace: "pre-wrap", fontSize: "var(--fs-2)" }}>{run.error}</div>
            <Link href="/classic" className="tp-btn press">Classic console</Link>
          </div>
        </div>
      );
    }
    return <V4Loading message={run.status} />;
  }
  return (
    <div className="v4">
      <PlayheadProvider snapshot={snapshot}>
        <Shell snapshot={snapshot} run={run} />
      </PlayheadProvider>
    </div>
  );
}

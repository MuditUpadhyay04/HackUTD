import { Suspense } from "react";
import type { Metadata } from "next";
import { LiveWall } from "@/components/live/live-wall";

export const metadata: Metadata = { title: "Night shift" };

/** The live wall: the screen to present and to leave on for the night shift. The full console stays at "/". */
export default function LivePage() {
  return (
    <Suspense fallback={<div className="min-h-screen" />}>
      <LiveWall />
    </Suspense>
  );
}

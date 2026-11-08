"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While board data streams in, re-render the server page every few seconds (pauses when the tab is hidden). */
export function LiveRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => window.clearInterval(id);
  }, [router, seconds]);
  return null;
}

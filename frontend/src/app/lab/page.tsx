import { Suspense } from "react";
import type { Metadata } from "next";
import { V4App } from "@/components/v4/app";
import { V4Loading } from "@/components/v4/loading";
import "../v4.css";

export const metadata: Metadata = { title: "Pipe View lab" };

export default function Page() {
  return (
    <Suspense fallback={<V4Loading />}>
      <V4App />
    </Suspense>
  );
}

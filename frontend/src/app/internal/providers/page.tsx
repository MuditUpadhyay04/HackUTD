import type { Metadata } from "next";
import { ProviderBoard } from "@/components/internal/provider-board";

export const metadata: Metadata = {
  title: "Model providers",
  robots: { index: false, follow: false },
};

export default function ProvidersPage() {
  return <ProviderBoard />;
}

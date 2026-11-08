import { redirect } from "next/navigation";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The classic console now lives at `/`; keep old /classic links working (query string preserved).
export default async function Page({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v != null) q.set(k, v);
  }
  redirect(q.size ? `/?${q.toString()}` : "/");
}

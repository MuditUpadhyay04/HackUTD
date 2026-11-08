import { NextRequest } from "next/server";

// Only expose the public operator API, never arbitrary upstream paths.
const allowed = /^api\/(health|board|datasets(?:\/[^/]+\/timeline)?|runs(?:\/[^/]+(?:\/(?:snapshot|analyses|events|export|actions|scenarios|cancel|agents|agent-runs))?)?|analyses\/[^/]+(?:\/cancel)?|scenarios\/[^/]+|agent-runs\/[^/]+|agents\/learning)$/;
const maxBody = 176 * 1024 * 1024; // matches the operator API (apps/api/src/app.ts)

function originsEqual(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (ua.protocol !== ub.protocol || ua.port !== ub.port) return false;
    const loopback = (h: string) => h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
    if (loopback(ua.hostname) && loopback(ub.hostname)) return true;
    return ua.hostname === ub.hostname;
  } catch { return false; }
}

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  const name = path.join("/");
  if (!allowed.test(name)) return new Response("Not found", { status: 404 });
  if (req.method !== "GET" && !originsEqual(req.headers.get("origin"), req.nextUrl.origin))
    return new Response("Origin rejected", { status: 403 });
  const length = Number(req.headers.get("content-length") || 0);
  if (length > maxBody) return new Response("Upload too large", { status: 413 });
  let body: ArrayBuffer | undefined;
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBody) { await reader.cancel(); return new Response("Upload too large", { status: 413 }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = bytes.buffer;
  }
  const headers = new Headers();
  for (const key of ["content-type", "accept", "idempotency-key", "last-event-id"]) {
    const value = req.headers.get(key); if (value) headers.set(key, value);
  }
  if (process.env.API_TOKEN) headers.set("authorization", `Bearer ${process.env.API_TOKEN}`);
  try {
    const upstream = new URL(`/${name}${req.nextUrl.search}`, process.env.API_URL || "http://127.0.0.1:3001");
    const res = await fetch(upstream, { method: req.method, headers, body, cache: "no-store", signal: req.signal, redirect: "manual" });
    const out = new Headers();
    for (const key of ["content-type", "content-disposition", "cache-control", "x-accel-buffering"]) {
      const value = res.headers.get(key); if (value) out.set(key, value);
    }
    out.set("x-content-type-options", "nosniff");
    return new Response(res.body, { status: res.status, headers: out });
  } catch { return new Response("Backend unavailable", { status: 502 }); }
}
export const GET = proxy;
export const POST = proxy;

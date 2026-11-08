import { NextRequest } from "next/server";

// The demo supervisor (scripts/demo.ts) owns the board processes. The console
// talks to it through this route so the browser stays on the same origin.

const demoUrl = process.env.DEMO_URL || "http://127.0.0.1:3099";

function sameOrigin(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.protocol !== right.protocol || left.port !== right.port) return false;
    const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
    return (loopback(left.hostname) && loopback(right.hostname)) || left.hostname === right.hostname;
  } catch {
    return false;
  }
}

async function forward(req: NextRequest): Promise<Response> {
  if (req.method === "POST" && !sameOrigin(req.headers.get("origin"), req.nextUrl.origin)) {
    return new Response("Origin rejected", { status: 403 });
  }
  try {
    const res = await fetch(demoUrl, {
      method: req.method,
      headers: req.method === "POST" ? { "content-type": "application/json" } : undefined,
      body: req.method === "POST" ? await req.text() : undefined,
      cache: "no-store",
      signal: req.signal,
    });
    return new Response(res.body, {
      status: res.status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch {
    return Response.json({ available: false });
  }
}

export const GET = forward;
export const POST = forward;

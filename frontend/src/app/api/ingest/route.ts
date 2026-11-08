// Receives Mudit's listen.py POST batches (ml/INTEGRATION.md §3). Off unless BOARD_INGEST=1.
// listen.py also POSTs [] while idle as a "server is up" check, so this must answer 2xx fast.
import { ingest } from "@/lib/live/ingest-store";

export async function POST(req: Request) {
  if (process.env.BOARD_INGEST !== "1") return new Response("ingest disabled", { status: 404 });
  const token = process.env.INGEST_TOKEN;
  if (token && new URL(req.url).searchParams.get("token") !== token) return new Response("forbidden", { status: 403 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("expected a JSON array", { status: 400 });
  }
  const n = ingest(body);
  return Response.json({ ok: true, accepted: n });
}

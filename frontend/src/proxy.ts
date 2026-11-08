import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

function equal(a: string, b: string) {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

export function proxy(request: NextRequest) {
  // Never require auth for Next.js internal assets (_next/*, favicon, etc.).
  // The browser loads these without sending Basic Auth credentials.
  if (request.nextUrl.pathname.startsWith("/_next/")) return NextResponse.next();

  // Host alone is client-controlled. Require an explicit loopback server bind as
  // well; never use this opt-out on a shared or reverse-proxied listener.
  const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (process.env.ALLOW_INSECURE_LOCAL === "1" && process.env.NODE_ENV === "development" &&
      loopback.has(process.env.HOSTNAME ?? "") && loopback.has(request.nextUrl.hostname) &&
      !request.headers.has("forwarded") &&
      (!request.headers.has("x-forwarded-host") || request.headers.get("x-forwarded-host") === request.headers.get("host"))) return NextResponse.next();

  const password = process.env.OPERATOR_PASSWORD;
  if (!password) return new Response("Operator authentication is not configured", { status: 503, headers: { "cache-control": "no-store" } });
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
  let valid = false;
  if (match) {
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon >= 0) valid = equal(decoded.slice(0, colon), "operator") && equal(decoded.slice(colon + 1), password);
  }
  if (!valid) return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="Operator console", charset="UTF-8"', "cache-control": "no-store" } });
  return NextResponse.next();
}

import { timingSafeEqual } from "node:crypto";
import { DomainError } from "@hackutd/contracts";
import type { AppConfig } from "./config";

export function authorize(request: Request, config: Pick<AppConfig, "apiToken" | "insecureLocal" | "allowedOrigins">): void {
  const origin = request.headers.get("origin");
  if (origin && !config.allowedOrigins.includes(origin)) throw new DomainError("ORIGIN_DENIED", "Origin is not permitted", 403);
  if (!config.apiToken) {
    if (!config.insecureLocal) throw new DomainError("UNAUTHORIZED", "Authentication required", 401);
    return;
  }
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${config.apiToken}`;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError("UNAUTHORIZED", "Authentication required", 401);
}

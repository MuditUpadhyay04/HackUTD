import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { proxy } from "./proxy";

const initial = { ...process.env };
afterEach(() => {
  for (const key of ["OPERATOR_PASSWORD", "ALLOW_INSECURE_LOCAL", "HOSTNAME", "NODE_ENV"]) {
    if (initial[key] === undefined) delete process.env[key]; else Object.assign(process.env, { [key]: initial[key] });
  }
});
const req = (url: string, authorization?: string, extra?: HeadersInit) => new NextRequest(url, { headers: { ...extra, ...(authorization ? { authorization } : {}) } });

describe("operator authentication", () => {
  test("fails closed without a password", () => {
    delete process.env.OPERATOR_PASSWORD;
    delete process.env.ALLOW_INSECURE_LOCAL;
    expect(proxy(req("http://localhost/api/backend/api/datasets")).status).toBe(503);
  });
  test("challenges invalid credentials and permits the operator", () => {
    process.env.OPERATOR_PASSWORD = "test-password";
    const invalid = proxy(req("http://localhost/", `Basic ${btoa("operator:incorrect")}`));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain("Basic");
    expect(proxy(req("http://localhost/", `Basic ${btoa("operator:test-password")}`)).status).toBe(200);
    expect(proxy(req("http://localhost/", `Basic ${btoa("other:test-password")}`)).status).toBe(401);
  });
  test("local bypass requires a development loopback bind and request", () => {
    delete process.env.OPERATOR_PASSWORD;
    Object.assign(process.env, { NODE_ENV: "development", ALLOW_INSECURE_LOCAL: "1", HOSTNAME: "127.0.0.1" });
    expect(proxy(req("http://127.0.0.1/")).status).toBe(200);
    expect(proxy(req("http://example.com/")).status).toBe(503);
    expect(proxy(req("http://127.0.0.1/", undefined, { forwarded: "host=example.com" })).status).toBe(503);
    expect(proxy(req("http://127.0.0.1/", undefined, { host: "127.0.0.1:3000", "x-forwarded-host": "example.com" })).status).toBe(503);
    expect(proxy(req("http://127.0.0.1/", undefined, { host: "127.0.0.1:3000", "x-forwarded-host": "127.0.0.1:3000" })).status).toBe(200);
    process.env.HOSTNAME = "0.0.0.0";
    expect(proxy(req("http://127.0.0.1/")).status).toBe(503);
  });
});

/**
 * Explicit independent bridge process. No socket is opened when imported.
 *
 * UNSUPPORTED SINK: this bridge POSTs batches to /api/hardware/batches, but the
 * operator API deliberately does not expose that endpoint. Hardware ingestion
 * (packet parsing, bounded queue, heartbeat bridge, offline DATA encoding) is
 * integration infrastructure awaiting the hardware owner's validation; it is
 * not wired into runs, inference persistence, or the operator console. Running
 * this bridge against the current API surfaces sendFailures (HTTP 404) rather
 * than silently accepting or fabricating FPGA data. Do not treat a running
 * bridge as operational FPGA integration.
 */
import dgram from "node:dgram";
import { isIP } from "node:net";
import { HardwareBridge } from "./features/hardware/bridge.ts";

export function startBridge(env: NodeJS.ProcessEnv = process.env) {
  const boardIp = env.BOARD_IP ?? "", runId = env.RUN_ID ?? "", epochId = env.BOARD_EPOCH_ID ?? "", token = env.API_TOKEN ?? "";
  if (isIP(boardIp) !== 4 || !token || !env.API_URL || !env.BOARD_SLOTS) throw new Error("BOARD_IP, RUN_ID, BOARD_EPOCH_ID, BOARD_SLOTS, API_URL and API_TOKEN required");
  const url = new URL("/api/hardware/batches", env.API_URL);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) throw new Error("API_URL must use HTTPS or loopback HTTP");
  const sockets = [dgram.createSocket("udp4"), dgram.createSocket("udp4")];
  const heartbeat = dgram.createSocket("udp4");
  const bridge = new HardwareBridge({ boardIp, runId, epochId, slots: env.BOARD_SLOTS.split(",").map(Number), knownWeights: env.KNOWN_WEIGHTS?.split(",").map(Number), capacity: Number(env.BRIDGE_CAPACITY ?? 1024),
    sendHeartbeat: bytes => heartbeat.send(bytes, 7003, boardIp, error => { if (error) console.error("heartbeat send failed", error.message); }),
    sendBatch: async batch => { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(batch), signal: AbortSignal.timeout(5000) }); if (!response.ok) throw new Error(`API returned ${response.status}`); },
  });
  for (const [i, socket] of sockets.entries()) {
    const port = (7001 + i) as 7001 | 7002;
    // Some Bun-only type installations omit Node's EventEmitter base typings.
    const events = socket as unknown as { on(event: "error", fn: (error: Error) => void): void; on(event: "message", fn: (bytes: Uint8Array, source: { address: string }) => void): void };
    events.on("error", error => { console.error("bridge socket error", error.message); close(); });
    events.on("message", (bytes, source) => bridge.receive(bytes, source.address, port));
    socket.bind(port, env.BRIDGE_BIND_IP ?? "0.0.0.0");
  }
  (heartbeat as unknown as { on(event: "error", fn: (error: Error) => void): void }).on("error", error => console.error("heartbeat socket error", error.message));
  const timer = setInterval(() => bridge.tick(), 1000);
  const report = setInterval(() => console.error("hardware bridge health", JSON.stringify(bridge.health)), 10000);
  function close() { clearInterval(timer); clearInterval(report); for (const s of sockets) { try { s.close(); } catch {} } try { heartbeat.close(); } catch {} }
  return { bridge, close };
}

if (import.meta.main) startBridge();

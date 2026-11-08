import { createApp } from "./app";
import { Application } from "./application";
import { loadConfig } from "./infrastructure/config";
import { createStore } from "./infrastructure/database";
import { runWorker } from "./infrastructure/jobs/worker";
import { readRegisteredModel } from "./features/runtimes/model";

const config = loadConfig();
const store = createStore({ databaseUrl: config.databaseUrl, memory: config.memory });
await store.init();
const service = new Application(store, config, config.modelMetadataPath ? await readRegisteredModel(config.modelMetadataPath) : undefined);
const app = createApp(service).listen({ port: config.port, hostname: config.host });
const controller = new AbortController();
if (process.env.INLINE_WORKER !== "0") void runWorker(service, controller.signal);
console.log(`Operator API listening on ${config.host}:${config.port}; storage=${config.memory ? "memory (NONPERSISTENT)" : "PostgreSQL"}`);
async function stop() { controller.abort(); app.stop(); await service.close(); await store.close(); process.exit(0); }
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

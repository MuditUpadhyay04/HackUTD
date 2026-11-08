import { SQL } from "bun";
import { DomainError, type AnalysisRecord, type ImportedDataset, type InferenceObservation, type LiveEvent, type OperatorAction, type RunRecord, type ScenarioRecord, type Snapshot } from "@hackutd/contracts";
import type { Job, Store } from "../../store";
import { migrate } from "./migrate";
import { MemoryStore, requestBody, cleanAnalysis, normalizeObservation } from "./memory";
export { MemoryStore } from "./memory";

const json = (v: unknown) => JSON.stringify(v);
const parsed = (v: any): any => typeof v === "string" ? JSON.parse(v) : v;
const job = (r: any): Job => ({ id:r.id, key:r.key, kind:r.kind, payload:parsed(r.payload), state:r.state, fence:Number(r.fence), leaseUntil:Number(r.lease_until), attempts:r.attempts, error:r.error });

export class PostgresStore implements Store {
  readonly mode = "postgres";
  private sql: SQL;
  constructor(databaseUrl: string) { if (!databaseUrl) throw new Error("DATABASE_URL is required"); this.sql = new SQL({url: databaseUrl, max: 8}); }
  async init() { await migrate(this.sql); }
  async close() { await this.sql.close(); }
  async listDatasets() { const rows = await this.sql`SELECT body->'info' AS info FROM datasets ORDER BY id`; return rows.map((r: any) => parsed(r.info)); }
  async getDataset(id: string): Promise<ImportedDataset | null> { const rows = await this.sql`SELECT body FROM datasets WHERE id=${id}`; return rows[0] ? parsed(rows[0].body) : null; }
  async putDataset(d: ImportedDataset): Promise<ImportedDataset> { return await this.sql.begin(async tx => { const inserted = await tx`INSERT INTO datasets(id,body) VALUES (${d.info.id},${json(d)}::text::jsonb) ON CONFLICT DO NOTHING RETURNING body`; if (!inserted.length) { const rows = await tx`SELECT body FROM datasets WHERE id=${d.info.id}`; return parsed(rows[0].body); } for (let i=0;i<d.samples.length;i+=1000) { const batch = d.samples.slice(i,i+1000).map(s => ({ts:s.tsUnix,asset:s.assetId,metric:s.metric,value:s.value})); await tx`INSERT INTO telemetry_samples(dataset_id,event_time,asset_id,metric,value) SELECT ${d.info.id},to_timestamp(x.ts),x.asset,x.metric,x.value FROM jsonb_to_recordset(${json(batch)}::text::jsonb) AS x(ts double precision,asset text,metric text,value double precision) ON CONFLICT DO NOTHING`; } return parsed(inserted[0].body); }); }
  async listRuns(): Promise<RunRecord[]> { const rows=await this.sql`SELECT body FROM runs ORDER BY id`; return rows.map((r: any)=>parsed(r.body)); }
  async getRun(id:string): Promise<RunRecord|null> { const rows=await this.sql`SELECT body FROM runs WHERE id=${id}`; return rows[0] ? parsed(rows[0].body) : null; }
  async putRun(r:RunRecord) { await this.sql`INSERT INTO runs(id,body) VALUES (${r.id},${json(r)}::text::jsonb) ON CONFLICT DO NOTHING`; }
  private async check(tx:any, claim: {jobId:string;fence:number}|undefined, kind:Job["kind"], id:string) { if (!claim) return; const rows=await tx`SELECT id FROM jobs WHERE id=${claim.jobId} AND fence=${claim.fence} AND state='running' AND lease_until > (extract(epoch from clock_timestamp()) * 1000)::bigint AND kind=${kind} AND payload->>'id'=${id} FOR UPDATE`; if (!rows.length) throw new DomainError("stale_claim","Job lease is no longer valid",409); }
  private async emit(tx:any, runId:string, type:LiveEvent["type"], data:unknown, revision=0):Promise<LiveEvent> { const rows=await tx`UPDATE runs SET cursor=cursor+1 WHERE id=${runId} RETURNING cursor`; if (!rows.length) throw new DomainError("not_found","Run not found",404); const cursor=Number(rows[0].cursor), createdAt=new Date().toISOString(); await tx`INSERT INTO live_events(run_id,cursor,revision,type,body,created_at) VALUES (${runId},${cursor},${revision},${type},${json(data)}::text::jsonb,${createdAt}::timestamptz)`; return {runId,cursor,revision,type,data,createdAt}; }
  async saveRun(r:RunRecord, claim?:{jobId:string;fence:number}) { await this.sql.begin(async tx => { await this.check(tx,claim,"run",r.id); const rows=await tx`SELECT body,cursor FROM runs WHERE id=${r.id} FOR UPDATE`; if (!rows.length) throw new DomainError("not_found","Run not found",404); await this.check(tx,claim,"run",r.id); if (parsed(rows[0].body).status === "cancelled" && r.status !== "cancelled") throw new DomainError("cancelled","Run is cancelled",409); const value=structuredClone(r); console.error("[db] saveRun snapshot keys:", value.snapshot ? Object.keys(value.snapshot) : "null"); console.error("[db] saveRun snapshot keys count:", value.snapshot ? Object.keys(value.snapshot).length : "null"); if (value.status === "ready" && value.snapshot) { value.snapshot.cursor=Number(rows[0].cursor)+1; await this.emit(tx,r.id,"snapshot",value.snapshot,value.snapshot.revision); } await tx`UPDATE runs SET body=${json(value)}::text::jsonb WHERE id=${r.id}`; }); }
  async getAnalysis(id:string):Promise<AnalysisRecord|null> { const rows=await this.sql`SELECT body FROM analyses WHERE id=${id}`; return rows[0] ? parsed(rows[0].body) : null; }
  async pendingAnalyses():Promise<AnalysisRecord[]> { const rows=await this.sql`SELECT body FROM analyses WHERE body->>'state' IN ('pending','running') ORDER BY id`; return rows.map((r: any)=>parsed(r.body)); }
  async putAnalysis(a:AnalysisRecord) { await this.sql`INSERT INTO analyses(id,run_id,body) VALUES (${a.id},${a.runId},${json(cleanAnalysis(a))}::text::jsonb) ON CONFLICT DO NOTHING`; }
  async saveAnalysis(a:AnalysisRecord,claim?:{jobId:string;fence:number}) { await this.sql.begin(async tx => { await this.check(tx,claim,"analysis",a.id); const rows=await tx`SELECT body FROM analyses WHERE id=${a.id} FOR UPDATE`; if (!rows.length) throw new DomainError("not_found","Analysis not found",404); await this.check(tx,claim,"analysis",a.id); if (parsed(rows[0].body).state === "cancelled" && a.state !== "cancelled") throw new DomainError("cancelled","Analysis is cancelled",409); if (parsed(rows[0].body).runId !== a.runId) throw new DomainError("invalid_request","Cannot change analysis run",409); const value=cleanAnalysis(a); await tx`UPDATE analyses SET body=${json(value)}::text::jsonb WHERE id=${a.id}`; await this.emit(tx,a.runId,"analysis",value,a.inputRevision); }); }
  async listActions(runId:string):Promise<OperatorAction[]> { const rows=await this.sql`SELECT body FROM operator_actions WHERE run_id=${runId} ORDER BY id`; return rows.map((r: any)=>parsed(r.body)); }
  async putAction(a:OperatorAction,key:string):Promise<OperatorAction> { return await this.sql.begin(async tx => { const request=requestBody(a); const rows=await tx`INSERT INTO operator_actions(id,run_id,idempotency_key,request,body) VALUES (${a.id},${a.runId},${key},${request}::text::jsonb,${json(a)}::text::jsonb) ON CONFLICT (run_id,idempotency_key) DO NOTHING RETURNING body`; if (rows.length) { await this.emit(tx,a.runId,"operator_action",a,a.revision); return parsed(rows[0].body); } const existing=await tx`SELECT body,request = ${request}::text::jsonb AS matches FROM operator_actions WHERE run_id=${a.runId} AND idempotency_key=${key}`; if (!existing[0].matches) throw new DomainError("idempotency_conflict","Idempotency key reused with different request",409); return parsed(existing[0].body); }); }
  async getScenario(id:string):Promise<ScenarioRecord|null> { const rows=await this.sql`SELECT body FROM scenarios WHERE id=${id}`; return rows[0] ? parsed(rows[0].body) : null; }
  async putScenario(s:ScenarioRecord,key:string):Promise<ScenarioRecord> { return await this.sql.begin(async tx => { const request=requestBody(s); const rows=await tx`INSERT INTO scenarios(id,run_id,idempotency_key,request,body) VALUES (${s.id},${s.runId},${key},${request}::text::jsonb,${json(s)}::text::jsonb) ON CONFLICT (run_id,idempotency_key) DO NOTHING RETURNING body`; if (rows.length) { await this.emit(tx,s.runId,"scenario",s,s.inputRevision); return parsed(rows[0].body); } const existing=await tx`SELECT body,request = ${request}::text::jsonb AS matches FROM scenarios WHERE run_id=${s.runId} AND idempotency_key=${key}`; if (!existing[0].matches) throw new DomainError("idempotency_conflict","Idempotency key reused with different request",409); return parsed(existing[0].body); }); }
  async enqueueJob(key:string,kind:Job["kind"],id:string):Promise<Job> { const rows=await this.sql`INSERT INTO jobs(id,key,kind,payload,state) VALUES (${crypto.randomUUID()},${key},${kind},${json({id})}::text::jsonb,'pending') ON CONFLICT (key) DO UPDATE SET key=excluded.key RETURNING *`; const j=job(rows[0]); if (j.kind !== kind || j.payload.id !== id) throw new DomainError("idempotency_conflict","Job key reused",409); return j; }
  async claimJob(now=Date.now(),leaseMs=30000):Promise<Job|null> { const rows=await this.sql`WITH candidate AS (SELECT id FROM jobs WHERE state='pending' OR (state='running' AND lease_until<=${now}) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE jobs j SET state='running',fence=j.fence+1,attempts=j.attempts+1,lease_until=${now+leaseMs} FROM candidate WHERE j.id=candidate.id RETURNING j.*`; return rows.length ? job(rows[0]) : null; }
  async renewJob(id:string,fence:number,leaseMs=30000):Promise<boolean> { const now=Date.now(); const rows=await this.sql`UPDATE jobs SET lease_until=${now+leaseMs} WHERE id=${id} AND fence=${fence} AND state='running' AND lease_until>${now} RETURNING id`; return !!rows.length; }
  async finishJob(id:string,fence:number,error?:string):Promise<boolean> { const now=Date.now(); const rows=await this.sql`UPDATE jobs SET state=${error ? "failed" : "completed"},error=${error ?? null},lease_until=0 WHERE id=${id} AND fence=${fence} AND state='running' AND lease_until>${now} RETURNING id`; return !!rows.length; }
  async appendInference(runId:string,epochId:string,results:InferenceObservation[],claim?:{jobId:string;fence:number}):Promise<void> {
    const observations=results.map(normalizeObservation);
    await this.sql.begin(async tx => {
      await this.check(tx,claim,"run",runId);
      const runs=await tx`SELECT body FROM runs WHERE id=${runId} FOR UPDATE`;
      if (!runs.length) throw new DomainError("not_found","Run not found",404);
      await this.check(tx,claim,"run",runId);
      if (parsed(runs[0].body).status === "cancelled") throw new DomainError("cancelled","Run is cancelled",409);
      for (const {value,serialized} of observations) {
        const inserted=await tx`INSERT INTO inference_receipts(run_id,epoch_id,result_no,observation) VALUES (${runId},${epochId},${value.resultNo},${serialized}::text::jsonb) ON CONFLICT DO NOTHING RETURNING result_no`;
        if (!inserted.length) {
          const existing=await tx`SELECT observation=${serialized}::text::jsonb AS matches FROM inference_receipts WHERE run_id=${runId} AND epoch_id=${epochId} AND result_no=${value.resultNo}`;
          if (!existing[0]?.matches) throw new DomainError("inference_conflict","Inference receipt has conflicting contents",409);
          continue;
        }
        await tx`INSERT INTO inference_results(run_id,epoch_id,result_no,event_time,facility_id,provenance,status,body) VALUES (${runId},${epochId},${value.resultNo},to_timestamp(${value.tsUnix}),${value.facilityId},${value.provenance},${value.status},${json(value.body)}::text::jsonb)`;
      }
      await this.check(tx,claim,"run",runId);
    });
  }
  async publish(runId:string,type:LiveEvent["type"],data:unknown,revision=0):Promise<LiveEvent> { return await this.sql.begin(tx => this.emit(tx,runId,type,data,revision)); }
  async events(runId:string,after:number,limit=100):Promise<LiveEvent[]> { const bound=Math.max(0,Math.min(Math.floor(limit),1000)); const rows=await this.sql`SELECT cursor,revision,type,body,created_at FROM live_events WHERE run_id=${runId} AND cursor>${after} ORDER BY cursor LIMIT ${bound}`; return rows.map((r: any)=>({runId,cursor:Number(r.cursor),revision:r.revision,type:r.type,data:parsed(r.body),createdAt:new Date(r.created_at).toISOString()})); }
  async snapshot(runId:string):Promise<Snapshot|null> { const rows=await this.sql`SELECT body->'snapshot' AS snapshot,cursor FROM runs WHERE id=${runId}`; console.error("[db] snapshot raw:", typeof rows[0]?.snapshot, rows[0]?.snapshot ? Object.keys(rows[0].snapshot) : "null/falsy"); return rows[0]?.snapshot ? {...parsed(rows[0].snapshot),cursor:Number(rows[0].cursor)} : null; }
}

export function createStore(options:{databaseUrl?:string;memory?:boolean} = {}):Store { if (options.memory) return new MemoryStore(); const url=options.databaseUrl ?? process.env.DATABASE_URL; if (!url) throw new Error("DATABASE_URL is required unless memory mode is explicitly selected"); return new PostgresStore(url); }

import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import type { AnalysisRecord, ImportedDataset, InferenceObservation, OperatorAction, RunRecord, Snapshot } from "@hackutd/contracts";
import { MemoryStore, PostgresStore } from "./index";
import type { Store } from "../../store";

function contract(name:string, make:()=>Store) {
  describe(name, () => {
    test("fencing, idempotency and contiguous outbox", async () => {
      const s=make(); await s.init();
      const id=crypto.randomUUID();
      const run:RunRecord={id,datasetId:"dataset",at:123,requested:"software",parentRunId:null,status:"pending",error:null,createdAt:new Date().toISOString(),snapshot:null};
      try {
        await s.putRun(run);
        const j=await s.enqueueJob(`run:${id}`,"run",id);
        const first=await s.claimJob(Date.now(),10); expect(first?.id).toBe(j.id);
        const second=await s.claimJob(Date.now()+20,30000); expect(second?.fence).toBe(2);
        await expect(s.saveRun({...run,status:"running"},{jobId:j.id,fence:1})).rejects.toThrow();
        const snap={runId:id,revision:1,cursor:0} as Snapshot;
        await s.saveRun({...run,status:"ready",snapshot:snap},{jobId:j.id,fence:2});
        const a:OperatorAction={id:crypto.randomUUID(),runId:id,incidentId:"incident",revision:1,kind:"inspection_ticket",createdAt:new Date().toISOString()};
        expect((await s.putAction(a,"key")).id).toBe(a.id);
        expect((await s.putAction({...a,id:crypto.randomUUID()},"key")).id).toBe(a.id);
        await expect(s.putAction({...a,incidentId:"different"},"key")).rejects.toThrow();
        await Promise.all(Array.from({length:10},()=>s.publish(id,"run",{})));
        const events=await s.events(id,0); expect(events.map(e=>e.cursor)).toEqual(Array.from({length:12},(_,i)=>i+1));
        expect((await s.snapshot(id))?.cursor).toBe(12);
        expect(await s.finishJob(j.id,1)).toBe(false);
        expect(await s.finishJob(j.id,2)).toBe(true);
      } finally { await s.close(); }
    });
    test("analysis recovery and fenced atomic inference receipts", async () => {
      const s=make(); await s.init();
      const id=crypto.randomUUID(), analysisId=crypto.randomUUID();
      const run:RunRecord={id,datasetId:"dataset",at:123,requested:"software",parentRunId:null,status:"pending",error:null,createdAt:new Date().toISOString(),snapshot:null};
      const analysis:AnalysisRecord={id:analysisId,runId:id,inputRevision:1,state:"pending",source:"nemotron",fxSessionId:"session-ref",messageId:"message-ref",steps:[],handoff:"",evidenceIds:[],planIds:[],error:null,createdAt:new Date().toISOString()};
      const observation:InferenceObservation={facilityId:"facility",tsUnix:1790000000,resultNo:7,provenance:"fpga",status:0,body:{nested:{x:1}}};
      try {
        await s.putRun(run); await s.putAnalysis(analysis);
        expect(await s.getAnalysis(analysisId)).toMatchObject({fxSessionId:"session-ref",messageId:"message-ref"});
        expect((await s.pendingAnalyses()).some(a=>a.id===analysisId)).toBe(true);
        await s.saveAnalysis({...analysis,state:"running"});
        expect((await s.pendingAnalyses()).some(a=>a.id===analysisId)).toBe(true);
        expect((await s.events(id,0))[0].data).toMatchObject({fxSessionId:"session-ref",messageId:"message-ref"});
        const j=await s.enqueueJob(`inference:${id}`,"run",id);
        expect((await s.claimJob(Date.now(),10))?.id).toBe(j.id);
        const claim=await s.claimJob(Date.now()+20,30000);
        await expect(s.appendInference(id,"epoch",[observation],{jobId:j.id,fence:1})).rejects.toThrow();
        await s.appendInference(id,"epoch",[observation],{jobId:j.id,fence:claim!.fence});
        await s.appendInference(id,"epoch",[observation],{jobId:j.id,fence:claim!.fence});
        await expect(s.appendInference(id,"epoch",[{...observation,tsUnix:observation.tsUnix+1}],{jobId:j.id,fence:claim!.fence})).rejects.toThrow();
        await expect(s.appendInference(id,"epoch",[{...observation,resultNo:8},{...observation,body:{different:true}}],{jobId:j.id,fence:claim!.fence})).rejects.toThrow();
        // The preceding batch rolled back; a different receipt 8 must still be accepted.
        await s.appendInference(id,"epoch",[{...observation,resultNo:8,body:{replacement:true}}],{jobId:j.id,fence:claim!.fence});
        await s.saveAnalysis({...analysis,state:"completed"});
        expect((await s.pendingAnalyses()).some(a=>a.id===analysisId)).toBe(false);
        expect((await s.getAnalysis(analysisId))?.messageId).toBe("message-ref");
        await s.finishJob(j.id,claim!.fence);
      } finally { await s.close(); }
    });
  });
}
contract("memory",()=>new MemoryStore());
if (process.env.TEST_DATABASE_URL) {
  contract("postgres (TEST_DATABASE_URL)",()=>new PostgresStore(process.env.TEST_DATABASE_URL!));
  test("concurrent migration runners and persisted inference rows", async () => {
    const url=process.env.TEST_DATABASE_URL!, stores=Array.from({length:4},()=>new PostgresStore(url));
    const sql=new SQL({url,max:1});
    try {
      await Promise.all(stores.map(s=>s.init()));
      const migrations=await sql`SELECT version,checksum FROM schema_migrations WHERE version='001_initial'`;
      expect(migrations).toHaveLength(1); expect(migrations[0].checksum).toMatch(/^[0-9a-f]{64}$/);
      const id=crypto.randomUUID();
      await stores[0].putRun({id,datasetId:"dataset",at:123,requested:"software",parentRunId:null,status:"pending",error:null,createdAt:new Date().toISOString(),snapshot:null});
      const row:InferenceObservation={facilityId:"facility",tsUnix:1790000000,resultNo:1,provenance:"fpga",status:2,body:{score:42}};
      await Promise.all(stores.map(s=>s.appendInference(id,"epoch",[row])));
      const rows=await sql`SELECT facility_id,provenance,status,body,extract(epoch from event_time) AS ts FROM inference_results WHERE run_id=${id} AND epoch_id='epoch'`;
      expect(rows).toHaveLength(1); expect(rows[0].facility_id).toBe("facility"); expect(Number(rows[0].ts)).toBe(row.tsUnix);
      expect(typeof rows[0].body === "string" ? JSON.parse(rows[0].body) : rows[0].body).toEqual({score:42});
      const receipts=await sql`SELECT result_no FROM inference_receipts WHERE run_id=${id}`; expect(receipts).toHaveLength(1);
    } finally { await Promise.all(stores.map(s=>s.close())); await sql.close(); }
  });
  test("datasets keep small jsonb and gzip bulk parts; pre-003 rows are compacted on init", async () => {
    const url=process.env.TEST_DATABASE_URL!, store=new PostgresStore(url), sql=new SQL({url,max:1});
    const dataset=(id:string):ImportedDataset=>({ info:{id,label:"t",startUnix:1790000000,nowUnix:1790000300,status:"ready",createdAt:new Date().toISOString(),fileHashes:{},warnings:[],hardwareEligible:true,hardwareReasons:[]},
      network:{} as ImportedDataset["network"], ops:{} as ImportedDataset["ops"],
      samples:[{tsUnix:1790000000,assetId:"a",metric:"m",value:1.5},{tsUnix:1790000300,assetId:"a",metric:"m",value:null}],
      frames:[{facilityId:"f",tsUnix:1790000000,inflowBpd:1,levelPct:null,pumpStatus:1,pumpFlowBpd:2,receiveFlowBpd:3,dischargePsi:4,pipelinePsi:5,wellStatus:[1,null],wellWaterBpd:[0.5]}],
      sourceFiles:{network:"{}",ops:"{}",telemetry:"ts_unix\n"} });
    try {
      await store.init();
      const fresh=dataset(crypto.randomUUID());
      expect((await store.putDataset(fresh)).info.id).toBe(fresh.info.id);
      expect(await store.getDataset(fresh.info.id)).toEqual(fresh);
      expect((await store.putDataset({...fresh,samples:[]})).samples).toEqual(fresh.samples); // first write wins
      const [row]=await sql`SELECT body ? 'samples' OR body ? 'frames' OR body ? 'sourceFiles' AS bulky, frames_gz IS NOT NULL AS packed FROM datasets WHERE id=${fresh.info.id}`;
      expect(row).toEqual({bulky:false,packed:true});
      const legacy=dataset(crypto.randomUUID());
      await sql`INSERT INTO datasets(id,body) VALUES (${legacy.info.id},${JSON.stringify(legacy)}::text::jsonb)`;
      expect(await store.getDataset(legacy.info.id)).toEqual(legacy); // readable before compaction
      await store.init();
      const [after]=await sql`SELECT body ? 'samples' AS bulky, frames_gz IS NOT NULL AS packed FROM datasets WHERE id=${legacy.info.id}`;
      expect(after).toEqual({bulky:false,packed:true});
      expect(await store.getDataset(legacy.info.id)).toEqual(legacy);
    } finally { await store.close(); await sql.close(); }
  });
}

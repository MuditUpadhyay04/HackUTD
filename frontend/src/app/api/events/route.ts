import { getSnapshot, listDatasets, toEventsJson } from "@/lib/engine";
import { defaultDataset } from "@/lib/format";


export async function GET(req: Request) {
  const url = new URL(req.url);
  const datasets = await listDatasets();
  const id = url.searchParams.get("dataset") ?? defaultDataset(datasets)?.id;
  if (!id || !datasets.some((d) => d.id === id)) {
    return Response.json({ error: `Unknown dataset "${id}"` }, { status: 404 });
  }
  const at = url.searchParams.get("at");
  const snapshot = await getSnapshot(id, at ? Number(at) : undefined);
  return new Response(JSON.stringify(toEventsJson(snapshot), null, 2), {
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="events-${id}.json"`,
    },
  });
}

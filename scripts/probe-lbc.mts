import { randomUUID } from "node:crypto";
import { buildSearchPayload, buildSearchUrl, parseSearchResponse } from "../apps/server/src/adapters/leboncoin/live.js";
import { WreqTransport } from "../apps/server/src/adapters/leboncoin/wreq-transport.js";
import { classifyDataDome } from "../apps/server/src/adapters/leboncoin/datadome.js";

// Une seule requête, sans base de données, compte, webhook, solveur ou rejeu.
const spec = { query: process.argv[2] ?? "rtx 3090", maxItems: 10 };
const transport = new WreqTransport();
const started = Date.now();
try {
  const response = await transport.request({
    url: "https://api.leboncoin.fr/finder/search",
    method: "POST",
    headers: {
      Accept: "application/json",
      api_key: "ba0c2dad52b3ec",
      Origin: "https://www.leboncoin.fr",
      Referer: buildSearchUrl(spec, 1),
      "x-lbc-experiment": Buffer.from(JSON.stringify({ version: 1, rollout_visitor_id: randomUUID() })).toString("base64"),
    },
    body: JSON.stringify(buildSearchPayload(spec, 1)),
  });
  const result = response.status === 200 ? parseSearchResponse(response.body) : null;
  console.log(JSON.stringify({
    at: new Date().toISOString(), profile: transport.profile, status: response.status,
    elapsedMs: Date.now() - started, ads: result?.ads.length ?? null,
    total: result?.total ?? null,
    challenge: classifyDataDome({ ...response, url: buildSearchUrl(spec, 1) })?.reason ?? null,
  }));
  if (!result) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ at: new Date().toISOString(), error: (error as Error).message }));
  process.exitCode = 1;
}

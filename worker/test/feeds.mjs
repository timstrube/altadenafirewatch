// Backend check for firewatch-api: every data source must report FAILED (never
// "nothing to report") when it errors, times out, or answers with an error message.
// Run from the repo folder:  node worker/test/feeds.mjs   (Node 22+, nothing to install)

import assert from "node:assert/strict";
import worker from "../src/worker.js";

// ---- Simulated responses ---------------------------------------------------
const json = (body, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const httpError = status => json({ error: "server error" }, status);
const networkError = () => async () => { throw new TypeError("fetch failed"); };

const OK = {
  ambient: json([{ lastData: { windgustmph: 12.4, windspeedmph: 6.1, winddir: 140, humidity: 39, tempf: 75.2 } }]),
  openmeteo: json({ current: { wind_gusts_10m: 10, wind_speed_10m: 5, wind_direction_10m: 200, relative_humidity_2m: 40, temperature_2m: 74 } }),
  purpleair: json({ data: [[263867, 2.1], [253397, 2.5], [288792, 2.3]] }),
  nws: json({ features: [] }),
  nifc: json({ features: [] }),
  evac: json({ features: [] }),
};
// ArcGIS services report errors as HTTP 200 with an "error" object.
const ARCGIS_ERROR = json({ error: { code: 500, message: "Error performing query operation", details: [] } });
const RED_FLAG = json({ features: [{ properties: { event: "Red Flag Warning" } }] });
const EVAC_ORDER = json({ features: [{ attributes: { STATUS: "Evacuation Order", ZONE_NAME: "LAC-1234", COUNTY: "Los Angeles" } }, { attributes: { STATUS: "Normal", ZONE_NAME: "LAC-9999" } }] });

function route(url) {
  const u = new URL(url);
  if (u.host === "api.ambientweather.net") return "ambient";
  if (u.host === "api.open-meteo.com") return "openmeteo";
  if (u.host === "api.purpleair.com") return "purpleair";
  if (u.host === "api.weather.gov") return u.searchParams.get("point").startsWith("34.213") ? "nwsMountains" : "nwsAltadena";
  if (u.pathname.includes("WFIGS")) return "nifc";
  if (u.pathname.includes("EVACUATIONS")) return "evac";
  throw new Error("unexpected URL " + url);
}

async function run(overrides = {}) {
  const handlers = { ...OK, nwsAltadena: OK.nws, nwsMountains: OK.nws, ...overrides };
  globalThis.fetch = async (url, init) => handlers[route(url)](url, init);
  const store = new Map();
  const env = {
    AMBIENT_API_KEY: "test", AMBIENT_APP_KEY: "test", PURPLEAIR_API_KEY: "test",
    FIREWATCH_KV: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
  };
  const log = console.log; console.log = () => {};
  try { await worker.scheduled({}, env, { waitUntil() {} }); } finally { console.log = log; }
  return JSON.parse(store.get("status"));
}

// ---- Checks ----------------------------------------------------------------
let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("ok ", name); }

await check("all sources healthy: everything reported as working", async () => {
  const s = await run();
  assert.equal(s.weather.source, "ambient");
  assert.equal(s.air.source, "purpleair"); assert.equal(s.air.avgPM25, 2.3); assert.equal(s.air.sensorCount, 3);
  assert.deepEqual(s.redflag, { active: false, watch: false, nearby: false });
  assert.equal(s.incidents.nifcOk, true); assert.equal(s.incidents.evacOk, true);
  assert.equal(s.incidents.evacActive, false);
  assert.ok(!Number.isNaN(Date.parse(s.updated)));
});

await check("ArcGIS error message (HTTP 200) on both feeds: both marked failed, not zero", async () => {
  const s = await run({ nifc: ARCGIS_ERROR, evac: ARCGIS_ERROR });
  assert.equal(s.incidents.nifcOk, false);
  assert.equal(s.incidents.evacOk, false);
});

await check("ArcGIS HTTP 500 on the evacuation feed only: evacOk false, nifcOk true", async () => {
  const s = await run({ evac: httpError(500) });
  assert.equal(s.incidents.evacOk, false);
  assert.equal(s.incidents.nifcOk, true);
});

await check("ArcGIS response with no features list: marked failed", async () => {
  const s = await run({ nifc: json({ fields: [] }) });
  assert.equal(s.incidents.nifcOk, false);
});

await check("evacuation order nearby: active, with zone and status", async () => {
  const s = await run({ evac: EVAC_ORDER });
  assert.equal(s.incidents.evacOk, true);
  assert.equal(s.incidents.evacActive, true);
  assert.equal(s.incidents.evacNote, "LAC-1234 (Evacuation Order)");
});

await check("NWS HTTP 500: red flag state marked unknown (error), not 'no warning'", async () => {
  const s = await run({ nwsAltadena: httpError(500), nwsMountains: httpError(500) });
  assert.equal(s.redflag.error, true);
});

await check("NWS answers for one point but fails for the other: unknown, even if the first had no warning", async () => {
  const s = await run({ nwsMountains: httpError(503) });
  assert.equal(s.redflag.error, true);
});

await check("NWS response with no alert list: marked unknown", async () => {
  const s = await run({ nwsAltadena: json({ title: "Unexpected Problem", status: 200 }) });
  assert.equal(s.redflag.error, true);
});

await check("Red Flag Warning in the mountains: active and nearby", async () => {
  const s = await run({ nwsMountains: RED_FLAG });
  assert.equal(s.redflag.active, true);
  assert.equal(s.redflag.nearby, true);
  assert.equal(s.redflag.error, undefined);
});

await check("PurpleAir HTTP 403: air quality unavailable", async () => {
  const s = await run({ purpleair: httpError(403) });
  assert.equal(s.air.source, "unavailable");
});

await check("PurpleAir answers but no sensor has a reading: unavailable, not 0", async () => {
  const s = await run({ purpleair: json({ data: [[263867, null], [253397, null]] }) });
  assert.equal(s.air.source, "unavailable");
});

await check("Ambient station error: falls back to Open-Meteo", async () => {
  const s = await run({ ambient: httpError(401) });
  assert.equal(s.weather.source, "open-meteo");
  assert.equal(s.weather.gustMph, 10);
});

await check("Ambient station with missing readings: falls back to Open-Meteo", async () => {
  const s = await run({ ambient: json([{ lastData: { winddir: 90 } }]) });
  assert.equal(s.weather.source, "open-meteo");
});

await check("both weather sources fail: weather unavailable, never NaN readings", async () => {
  const s = await run({ ambient: httpError(500), openmeteo: json({ error: true, reason: "bad request" }) });
  assert.equal(s.weather.source, "unavailable");
});

await check("network down for everything: every source marked failed", async () => {
  const down = networkError();
  const s = await run({ ambient: down, openmeteo: down, purpleair: down, nwsAltadena: down, nwsMountains: down, nifc: down, evac: down });
  assert.equal(s.weather.source, "unavailable");
  assert.equal(s.air.source, "unavailable");
  assert.equal(s.redflag.error, true);
  assert.equal(s.incidents.nifcOk, false);
  assert.equal(s.incidents.evacOk, false);
});

await check("NWS requests identify the site, not a personal email", async () => {
  let ua;
  await run({ nwsAltadena: async (url, init) => { ua = init.headers["User-Agent"]; return OK.nws(); } });
  assert.match(ua, /altaready\.info/);
  assert.doesNotMatch(ua, /@/);
});

console.log(`\nALL CHECKS PASSED (${passed}) — worker/src/worker.js`);

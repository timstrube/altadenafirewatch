// Failure-state test for index.html: a failed, stale or partial data load must
// never look like an all-clear, and a known red flag or evacuation must never
// silently disappear.
//
// Run from the repo root:   node tests/fail-states.mjs
// Optional: another page:   node tests/fail-states.mjs index-clay.html
// Needs Node 22+ and Google Chrome. Set CHROME=/path/to/chrome if it's not in
// the default macOS location. Prints "ALL CHECKS PASSED" or exits with an error.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = process.argv[2] || "index.html";
const html = readFileSync(join(root, page));
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Serves only the page under test.
const server = createServer((req, res) => {
  if (new URL(req.url, "http://x").pathname === "/" + page) res.writeHead(200, { "content-type": "text/html" }).end(html);
  else res.writeHead(404).end();
}).listen(0, "127.0.0.1");
await new Promise(r => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/${page}`;

const profile = mkdtempSync(join(tmpdir(), "fail-states-"));
const chrome = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });

let ws;
try {
  // Chrome writes its debugging port to this file once it's ready.
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch {}
  }
  assert(port, "Chrome did not start (set CHROME=/path/to/chrome)");
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());

  ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0;
  const pending = new Map(), events = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else events.push(d);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank" });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  const cdp = (m, p) => send(m, p, sessionId);
  await cdp("Page.enable");
  await cdp("Runtime.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const evaluate = async expression =>
    (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;

  // Everything the checks need from the page, including the contrast of every text line in the status box.
  const READ = `(() => {
    const g = id => document.getElementById(id);
    const px = c => c.match(/[\\d.]+/g).map(Number);
    const lum = ([r, gr, b]) => { const f = v => (v /= 255) <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; return .2126 * f(r) + .7152 * f(gr) + .0722 * f(b); };
    const bgOf = el => { for (let e = el; e; e = e.parentElement) { const v = px(getComputedStyle(e).backgroundColor); if (v.length < 4 || v[3] === 1) return v.slice(0, 3); } return [255, 255, 255]; };
    const contrast = [...g("hero").querySelectorAll("*")]
      .filter(el => [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
      .map(el => {
        let a = 1; for (let e = el; e; e = e.parentElement) a *= +getComputedStyle(e).opacity;
        const bg = bgOf(el), fg = px(getComputedStyle(el).color).slice(0, 3).map((c, i) => c * a + bg[i] * (1 - a));
        const [x, y] = [lum(fg), lum(bg)].sort((p, q) => q - p);
        return +((x + .05) / (y + .05)).toFixed(2);
      });
    return {
      score: g("hero-score").textContent, level: g("hero-level").textContent, updated: g("hero-updated").textContent,
      heroBg: g("hero").style.background, redRow: g("row-redflag").style.background,
      badges: ["weather", "aq", "redflag", "incidents"].map(r => g(r + "-badge").style.background),
      alerts: [...document.querySelectorAll("#hero-alert div")].map(d => d.textContent), contrast,
    };
  })()`;

  let stubId = null;
  // Loads the page, optionally with window.fetch replaced, and waits for the status box to render.
  const load = async (query = "", fetchStub = null) => {
    if (stubId) await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: stubId });
    stubId = fetchStub ? (await cdp("Page.addScriptToEvaluateOnNewDocument", { source: fetchStub })).result.identifier : null;
    events.length = 0;
    await cdp("Page.navigate", { url: base + query });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const level = await evaluate(`document.getElementById("hero-level")?.textContent`);
      if (level && level !== "Loading…") break;
    }
    return read();
  };
  const read = async () => {
    const r = await evaluate(READ);
    r.exceptions = events.filter(e => e.method === "Runtime.exceptionThrown").length;
    return r;
  };
  const refresh = async () => { await evaluate("loadAll()"); await sleep(200); return read(); };

  const grey = (r, name) => {
    assert.equal(r.score, "—", `${name}: score shown`);
    assert.equal(r.heroBg, "var(--neutral-bg)", `${name}: status box not grey`);
  };
  const passesAA = (r, name) => assert(r.contrast.every(c => c >= 4.5), `${name}: status box contrast ${r.contrast}`);
  const noException = (r, name) => assert.equal(r.exceptions, 0, `${name}: page threw an exception`);
  const snapshot = (o = {}) => ({
    updated: new Date().toISOString(),
    weather: { source: "ambient", gustMph: 4, humidity: 55, windDirDeg: 270, tempF: 68 },
    redflag: { active: false }, air: { source: "purpleair", avgPM25: 5, sensorCount: 3 },
    incidents: { nifcOk: true, evacOk: true, nifcCount: 0 }, ...o,
  });
  const respondWith = body => `window.fetch = async () => new Response(${JSON.stringify(JSON.stringify(body))})`;
  // Answers each refresh with the next snapshot in the list; a null entry simulates the Worker being unreachable.
  const sequence = list => `const seq = ${JSON.stringify(list)}; let n = 0;
    window.fetch = async () => { const d = seq[Math.min(n++, seq.length - 1)];
      if (d === null) throw new TypeError("Failed to fetch"); return new Response(JSON.stringify(d)); }`;
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log("ok  " + name); };

  // ---- Normal states still score as before, with no alert boxes and AA contrast ----
  for (const [q, score, level] of [["clear", "3", "Low Risk"], ["watch", "38", "Elevated Risk"], ["santaana", "58", "High Risk"],
                                   ["redflag", "60", "High Risk"], ["critical", "100", "Critical Risk"]]) {
    await check(`debug=${q}: ${score} ${level}`, async () => {
      const r = await load("?debug=" + q);
      assert.equal(r.score, score); assert.equal(r.level, level);
      assert.match(r.updated, /^Updated /); assert.deepEqual(r.alerts, []);
      passesAA(r, q); noException(r, q);
    });
  }

  // ---- Worker failures ----
  await check("debug=offline: grey, no green anywhere", async () => {
    const r = await load("?debug=offline");
    grey(r, "offline"); assert.equal(r.level, "Data unavailable"); assert.equal(r.updated, "No successful update yet");
    assert(r.badges.every(b => b === "var(--neutral-bg)"), "a row badge is coloured");
    assert.deepEqual(r.alerts, []); passesAA(r, "offline"); noException(r, "offline");
  });

  await check("server error response: grey", async () => {
    const r = await load("", `window.fetch = async () => new Response('{"error":"boom"}', { status: 500 })`);
    grey(r, "500"); assert.equal(r.level, "Data unavailable");
  });

  await check("snapshot with no timestamp: grey", async () => {
    const { updated, ...rest } = snapshot();
    const r = await load("", respondWith(rest));
    grey(r, "no timestamp"); assert.equal(r.level, "Data unavailable");
  });

  await check("stale snapshot with no alerts: grey, nothing invented", async () => {
    const r = await load("", respondWith(snapshot({ updated: new Date(Date.now() - 2 * 3600e3).toISOString() })));
    grey(r, "stale"); assert.equal(r.level, "Data unavailable"); assert.match(r.updated, /^Last updated /);
    assert.deepEqual(r.alerts, []);
  });

  await check("debug=stale: red flag and evacuation kept as last known", async () => {
    const r = await load("?debug=stale");
    grey(r, "debug=stale"); assert.equal(r.level, "Data unavailable");
    assert.equal(r.alerts.length, 2);
    assert.match(r.alerts[0], /^Last known: Red Flag Warning \(as of .+\)$/);
    assert.match(r.alerts[1], /^Last known: Evacuation — Zone A-12 \(EVACUATION ORDER\) \(as of .+\)$/);
    passesAA(r, "debug=stale");
  });

  // ---- Partial failures ----
  await check("debug=partial (red flag source down): grey, no risk level", async () => {
    const r = await load("?debug=partial");
    grey(r, "partial"); assert.equal(r.level, "Data incomplete");
    assert.match(r.updated, /^Incomplete: Red Flag Warning unavailable · Updated /); passesAA(r, "partial");
  });

  await check("debug=partial-aq (air quality down): coloured score, marked incomplete", async () => {
    const r = await load("?debug=partial-aq");
    assert.equal(r.score, "23"); assert.equal(r.level, "Guarded Risk"); assert.equal(r.heroBg, "var(--guard-bg)");
    assert.match(r.updated, /^Incomplete: Air Quality unavailable · Updated /); passesAA(r, "partial-aq");
  });

  await check("incidents source down during a red flag: red flag shown as active now", async () => {
    const r = await load("", respondWith(snapshot({ redflag: { active: true }, incidents: { nifcOk: false, evacOk: false } })));
    grey(r, "incidents down"); assert.equal(r.level, "Data incomplete");
    assert.deepEqual(r.alerts, ["Active now: Red Flag Warning"]);
  });

  await check("red flag source down during an evacuation: evacuation shown as active now", async () => {
    const r = await load("", respondWith(snapshot({ redflag: { error: "x" },
      incidents: { nifcOk: true, evacOk: true, evacActive: true, evacNote: "Zone B-3 (EVACUATION WARNING)", nifcCount: 1 } })));
    grey(r, "red flag down"); assert.deepEqual(r.alerts, ["Active now: Evacuation — Zone B-3 (EVACUATION WARNING)"]);
  });

  // ---- Only the evacuation feed fails (review finding 1) ----
  await check("debug=evac-feed-down: evacuation kept as last known", async () => {
    const r = await load("?debug=evac-feed-down");
    grey(r, "evac-feed-down"); assert.equal(r.level, "Data incomplete");
    assert.match(r.updated, /^Incomplete: Confirmed Incidents unavailable · Updated /);
    assert.equal(r.alerts.length, 1);
    assert.match(r.alerts[0], /^Last known: Evacuation — Zone A-12 \(EVACUATION ORDER\) \(as of .+\)$/);
    passesAA(r, "evac-feed-down"); noException(r, "evac-feed-down");
  });

  await check("evacuation order, then only the evacuation feed fails, then it recovers", async () => {
    const evac = { nifcOk: true, evacOk: true, evacActive: true, evacNote: "Zone A-12 (EVACUATION ORDER)", nifcCount: 1 };
    let r = await load("", sequence([
      snapshot({ incidents: evac }),
      snapshot({ incidents: { nifcOk: true, evacOk: false, evacActive: false, nifcCount: 1 } }),
      snapshot({ incidents: { nifcOk: true, evacOk: true, evacActive: false, nifcCount: 0 } }),
    ]));
    assert.equal(r.level, "High Risk"); // calm weather 3 + evacuation 60 = 63

    r = await refresh();
    grey(r, "evac feed down"); assert.equal(r.level, "Data incomplete");
    assert.match(r.alerts[0] || "", /^Last known: Evacuation — Zone A-12 \(EVACUATION ORDER\) \(as of /);

    r = await refresh(); // evacuation feed back, order lifted
    assert.equal(r.level, "Low Risk"); assert.deepEqual(r.alerts, []);
  });

  // ---- A refresh fails after a red flag day ----
  await check("red flag, then Worker down, then red flag source down, then recovery", async () => {
    let r = await load("", sequence([
      snapshot({ redflag: { active: true } }),
      null,
      snapshot({ redflag: { error: "x" } }),
      snapshot(),
    ]));
    assert.equal(r.level, "Elevated Risk"); // calm weather 3 + red flag 40 = 43

    r = await refresh();
    grey(r, "worker down"); assert.equal(r.level, "Data unavailable"); assert.match(r.updated, /^Last updated /);
    assert.match(r.alerts[0] || "", /^Last known: Red Flag Warning \(as of /);
    assert(r.redRow.includes("--card"), "red flag row still red while unavailable");

    r = await refresh();
    grey(r, "red flag source down"); assert.equal(r.level, "Data incomplete");
    assert.match(r.alerts[0] || "", /^Last known: Red Flag Warning \(as of /);

    r = await refresh();
    assert.equal(r.level, "Low Risk"); assert.deepEqual(r.alerts, []); passesAA(r, "recovered");
  });

  console.log(`\nALL CHECKS PASSED (${passed.length}) — ${page}`);
} finally {
  ws?.close();
  chrome.kill();
  server.close();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}

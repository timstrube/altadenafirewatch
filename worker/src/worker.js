/* ===================================================================
   ALTADENA FIRE WATCH — Cloudflare Worker
   fetch()     -> serves visitors the latest snapshot from KV. Instant,
                  no third-party API calls, safe for any traffic volume.
   scheduled() -> runs every 15 min (Cron Trigger), calls every data
                  source once, and writes the result to KV.
   =================================================================== */

export default {
  async fetch(request, env, ctx) {
    const cached = await env.FIREWATCH_KV.get("status");
    if (cached) {
      return new Response(cached, {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        },
      });
    }

    // Bootstrap path — only hit before the very first cron run ever fires.
    const status = await computeStatus(env);
    ctx.waitUntil(env.FIREWATCH_KV.put("status", JSON.stringify(status)));
    return new Response(JSON.stringify(status), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=60",
      },
    });
  },

  async scheduled(event, env, ctx) {
    const status = await computeStatus(env);
    await env.FIREWATCH_KV.put("status", JSON.stringify(status));
  },
};

async function computeStatus(env) {
  const [weather, air, redflag, incidents] = await Promise.all([
    getWeather(env),
    getAirQuality(env),
    getRedFlag(),
    getIncidents(),
  ]);
  return { weather, air, redflag, incidents, updated: new Date().toISOString() };
}

/* ---------------- Weather: your Ambient Weather station first,
   Open-Meteo pinned to ZIP 91001 (Altadena) as fallback ---------------- */
async function getWeather(env) {
  try {
    const url = `https://api.ambientweather.net/v1/devices?apiKey=${env.AMBIENT_API_KEY}&applicationKey=${env.AMBIENT_APP_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const last = data[0].lastData;
    return {
      source: "ambient",
      gustMph: Math.round(last.windgustmph),
      windSpeedMph: Math.round(last.windspeedmph),
      windDirDeg: last.winddir,
      humidity: Math.round(last.humidity),
      tempF: Math.round(last.tempf),
    };
  } catch (e) {
    console.log("Ambient Weather failed, falling back to Open-Meteo:", e.message);
  }

  try {
    // Centroid of ZIP 91001 (Altadena, CA).
    const url = "https://api.open-meteo.com/v1/forecast?latitude=34.196307&longitude=-118.135582" +
      "&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,temperature_2m" +
      "&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=America%2FLos_Angeles";
    const res = await fetch(url);
    const data = await res.json();
    const c = data.current;
    return {
      source: "open-meteo",
      gustMph: Math.round(c.wind_gusts_10m),
      windSpeedMph: Math.round(c.wind_speed_10m),
      windDirDeg: c.wind_direction_10m,
      humidity: Math.round(c.relative_humidity_2m),
      tempF: Math.round(c.temperature_2m),
    };
  } catch (e) {
    return { source: "unavailable" };
  }
}

/* ---------------- Air quality: your PurpleAir sensors ---------------- */
async function getAirQuality(env) {
  // Fill in your three canyon sensor IDs from map.purpleair.com.
  const SENSOR_IDS = [263867,253397,288792];
  if (SENSOR_IDS.length === 0) return { source: "unavailable" };
  try {
    const ids = SENSOR_IDS.join(",");
    const url = `https://api.purpleair.com/v1/sensors?show_only=${ids}&fields=pm2.5_10minute`;
    const res = await fetch(url, { headers: { "X-API-Key": env.PURPLEAIR_API_KEY } });
    const data = await res.json();
    const readings = (data.data || []).map(r => r[1]).filter(v => typeof v === "number");
    const avgPM = readings.length
      ? Math.round((readings.reduce((a, b) => a + b, 0) / readings.length) * 10) / 10
      : null;
    return { source: "purpleair", avgPM25: avgPM, sensorCount: readings.length };
  } catch (e) {
    return { source: "unavailable" };
  }
}

/* ---------------- Red flag warning: NWS ----------------
   Checks Altadena itself AND the adjacent San Gabriel Mountains,
   since Altadena's own zone rarely gets a Red Flag Warning even
   when the foothills immediately above it are under one. */
const REDFLAG_POINTS = [
  { lat: 34.196307, lon: -118.135582, label: "altadena" },     // ZIP 91001 centroid — matches weather fallback
  { lat: 34.2130,    lon: -118.0970,  label: "sg_mountains" }, // Angeles NF foothills just north of town
];

async function getRedFlag() {
  let active = false, watch = false, nearby = false;

  try {
    for (const p of REDFLAG_POINTS) {
      const url = `https://api.weather.gov/alerts/active?point=${p.lat},${p.lon}`;
      const res = await fetch(url, {
        headers: {
          "Accept": "application/geo+json",
          // NWS asks for an identifying User-Agent with a contact (a website is accepted).
          "User-Agent": "altaready.info (https://altaready.info)",
        },
      });
      const data = await res.json();
      const events = (data.features || []).map(f => f.properties.event);

      if (events.includes("Red Flag Warning")) {
        active = true;
        if (p.label === "sg_mountains") nearby = true;
      }
      if (events.includes("Fire Weather Watch")) {
        watch = true;
      }
    }
    return { active, watch, nearby };
  } catch (e) {
    return { active: false, watch: false, nearby: false, error: true };
  }
}

/* ---------------- Incidents: NIFC current fires + Cal OES evac zones ---------------- */
async function getIncidents() {
  const envelope = "-118.21,34.14,-118.07,34.26";
  let nifcCount = 0, nifcOk = false;
  let evacActive = false, evacNote = "", evacOk = false;

  try {
    const url = "https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/" +
      "WFIGS_Incident_Locations_Current/FeatureServer/0/query" +
      `?where=1%3D1&geometry=${envelope}&geometryType=esriGeometryEnvelope` +
      "&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=IncidentName&returnGeometry=false&f=json";
    const res = await fetch(url);
    const data = await res.json();
    nifcCount = (data.features || []).length;
    nifcOk = true;
  } catch (e) { console.log("NIFC fetch failed:", e.message); }

  try {
    const url = "https://services.arcgis.com/BLN4oKB0N1YSgvY8/arcgis/rest/services/" +
      "CA_EVACUATIONS_CalOESHosted_view/FeatureServer/0/query" +
      `?where=1%3D1&geometry=${envelope}&geometryType=esriGeometryEnvelope` +
      "&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=STATUS,ZONE_NAME,COUNTY&returnGeometry=false&f=json";
    const res = await fetch(url);
    const data = await res.json();
    const features = data.features || [];
    const active = features.filter(f => {
      const status = (f.attributes || {}).STATUS;
      return status && String(status).toUpperCase() !== "NORMAL";
    });
    evacActive = active.length > 0;
    evacNote = evacActive
      ? active.map(f => `${f.attributes.ZONE_NAME || "Zone"} (${f.attributes.STATUS})`).slice(0, 2).join(", ")
      : "";
    evacOk = true;
  } catch (e) { console.log("Cal OES evac fetch failed:", e.message); }

  return { nifcCount, nifcOk, evacActive, evacNote, evacOk };
}

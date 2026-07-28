# Altadena Fire Watch

A public, real-time wildfire early-warning page for Altadena, CA — combining a local weather station, air quality sensors, and official fire/evacuation feeds into a single composite risk score.

## What this is

Altadena Fire Watch is a static, client-side page that aggregates live conditions from a local Ambient Weather station, nearby PurpleAir air quality sensors, National Weather Service red flag alerts, and NIFC/Cal OES incident and evacuation data into a single 0–100 fire-risk score. The weather component uses the Fosberg Fire Weather Index (Fosberg, 1978) — the same category of formula used operationally by NWS and the US Forest Service — which derives fire danger from temperature, humidity, and wind speed via an equilibrium fuel-moisture model, with an added directional weighting for Santa Ana wind events given their role in the 2025 Eaton Fire. Air quality is scored against EPA's official PM2.5 AQI breakpoints. Official red flag warnings and confirmed evacuation orders act as hard overrides on the composite score rather than just inputs, so an authoritative alert can never be diluted by otherwise-calm conditions. Private data sources (the weather station and PurpleAir keys) are proxied through a Cloudflare Worker so no credentials are ever exposed client-side; Open-Meteo serves as an automatic fallback if the local station goes offline.

## Data sources

| Source | Purpose | Access |
|---|---|---|
| Ambient Weather (via Cloudflare Worker) | Local wind, humidity, temperature | Requires a free API key + application key, kept server-side |
| Open-Meteo | Fallback weather if the local station is offline | Free, no key |
| PurpleAir (via Cloudflare Worker) | Local PM2.5 air quality | Requires a free developer key, kept server-side |
| National Weather Service (api.weather.gov) | Red flag warnings / fire weather watches | Free, no key |
| NIFC (WFIGS Current Incident Locations) | Active nearby wildfire incidents | Free, public ArcGIS feature service |
| Cal OES (California Evacuation Aggregation Layer) | Active evacuation warnings/orders | Free, public ArcGIS feature service |

## Architecture

```
Browser (this page)
  ├─▶ Open-Meteo, NWS, NIFC, Cal OES   (called directly — all public, keyless)
  └─▶ Cloudflare Worker                (called for weather + air quality)
        ├─▶ Ambient Weather API        (key stored as a Worker secret)
        └─▶ PurpleAir API              (key stored as a Worker secret)
```

The Worker also applies a short cache so a burst of site traffic doesn't translate into a burst of requests against the underlying weather station or sensor accounts.

## Scoring

Each of the four inputs contributes an independent sub-score, summed into a 0–100 composite:

- **Weather** (0–50): Fosberg Fire Weather Index scaled down, plus a Santa Ana wind-direction bonus.
- **Red flag warning** (0–40): binary NWS alert state; an active warning acts as a floor on the composite.
- **Air quality** (0–30): PM2.5 mapped against EPA AQI breakpoints (12 / 35.4 / 55.4 µg/m³).
- **Incidents** (0–60): confirmed evacuation zones or nearby active wildfire incidents; an active evacuation acts as a floor on the composite.

Composite bands: Low (0–14), Guarded (15–29), Elevated (30–49), High (50–69), Critical (70–100).

## Disclaimer

This is not an official emergency alert system. In an active emergency, follow instructions from Los Angeles County and local fire authorities.

## Setup

1. Deploy `altadena-fire-watch.html` as a static page (see deployment steps).
2. Set up a Cloudflare Worker with `AMBIENT_API_KEY`, `AMBIENT_APP_KEY`, and `PURPLEAIR_API_KEY` as encrypted secrets.
3. Update the `WORKER_URL` constant near the top of the page's `<script>` block to point at your deployed Worker.

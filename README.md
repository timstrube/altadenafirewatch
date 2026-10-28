# altaready

A free, public wildfire early-warning page for Altadena, California, at **[altaready.info](https://altaready.info)**.

It brings together a local weather station, nearby air-quality sensors, National Weather Service fire alerts, and official fire-incident and evacuation feeds into one 0–100 fire-risk score, refreshed every 15 minutes.

> **This is not an official emergency alert system.** In an active emergency, check on your neighbors and follow the instructions of local and county officials. Sign up for official alerts at [Genasys Protect](https://protect.genasys.com) and follow [Cal Fire](https://www.fire.ca.gov/incidents).

## How it works

```
Every 15 minutes
  firewatch-api (Cloudflare Worker, scheduled)
    ├─▶ Ambient Weather station   (Open-Meteo as fallback)
    ├─▶ PurpleAir sensors
    ├─▶ National Weather Service  (red flag warnings, fire weather watches)
    ├─▶ NIFC                      (current wildfire incidents)
    └─▶ Cal OES                   (evacuation warnings and orders)
          └─▶ saves one snapshot to Cloudflare KV storage

Every visitor
  altaready.info (Cloudflare Worker serving index.html)
    └─▶ reads that snapshot from firewatch-api
```

Visitors never call the data sources directly, so traffic spikes during an emergency don't hit them. The API keys live only as Cloudflare secrets.

## Scoring

Four sub-scores are added together into a 0–100 total:

| Source | Points | Based on |
|---|---|---|
| Weather | 0–50 | Fosberg Fire Weather Index (temperature, humidity, wind gusts), plus 5 for winds from the Santa Ana direction (20°–100°) |
| NWS alerts | 0, 15 or 40 | 40 for a Red Flag Warning at Altadena or the foothills just above it; 15 for a Fire Weather Watch |
| Air quality | 0–30 | Average PM2.5 against EPA breakpoints (12 / 35 / 55 µg/m³) |
| Incidents | 0, 20 or 60 | 60 for an active evacuation warning or order nearby; 20 for nearby fire incidents with no evacuation |

Risk levels: **Low** 0–14 · **Guarded** 15–29 · **Elevated** 30–49 · **High** 50–69 · **Critical** 70–100.

The NWS check queries two points, Altadena itself and the Angeles National Forest foothills (`34.2130, -118.0970`), because Altadena's own forecast zone rarely receives a Red Flag Warning even when the mountains directly above it do.

## When data is missing

The page never shows a failure as an all-clear:

- **No data, or data older than 45 minutes:** the score box turns grey and says "Data unavailable", with the time of the last good update. No score, no risk level.
- **Red flag or incident/evacuation source missing:** grey "Data incomplete", because either one could be an active alert.
- **Only weather or air quality missing:** the score still shows, marked "Incomplete".
- **An alert seen earlier stays visible** ("Last known: Red Flag Warning, as of …") until fresh data says it has ended.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The whole website: one self-contained page |
| `wrangler.jsonc` | Settings for the website's Cloudflare Worker (`altaready`) |
| `.assetsignore` | Files kept off the public site (this README, tests, backend code) |
| `tests/fail-states.mjs` | Automated checks of every normal and failure state |
| `worker/` | The data backend (`firewatch-api`): its code and settings |

## Deploying

- **Website:** pushing to `main` deploys `index.html` to altaready.info automatically, usually within a minute, through Cloudflare's GitHub connection. Pushes to other branches build a preview without touching the live site.
- **Backend:** `worker/` is a record of the live `firewatch-api` Worker and is **not** deployed automatically. Changes to it are deployed separately and deliberately.

## Testing

Run `node tests/fail-states.mjs` from the repo folder before pushing changes to `index.html`. It needs only Node and Google Chrome.

To preview a state by hand, add a debug parameter to the address, e.g. `altaready.info/?debug=critical`:

| Parameter | Shows |
|---|---|
| `clear` | Low risk, everything normal |
| `watch` | Fire Weather Watch with Santa Ana winds |
| `santaana` | Santa Ana winds, High risk |
| `redflag` | Active Red Flag Warning |
| `critical` | Red flag plus an evacuation order |
| `offline` | Data unavailable |
| `stale` | Old data that had a red flag and evacuation |
| `partial` | Red flag source missing ("Data incomplete") |
| `partial-aq` | Only air quality missing |
| `evac-feed-down` | Evacuation feed fails after an evacuation order |
| `fire-feed-down` | Fire-incident feed down |

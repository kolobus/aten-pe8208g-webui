# PDU Controller

A Node.js web app for monitoring and controlling an ATEN PE8208G 8-outlet rack PDU over SNMP.

- Live telemetry (voltage, current, power, energy) per outlet, polled every 2 s
- Click-to-toggle outlet control, batch on/off/reboot, outlet renaming
- Visual rendering of the 1U chassis with IEC 60320 C13/C19 sockets and status LEDs
- Small: Express + vanilla HTML/CSS/JS, no frontend framework

## Quick start (Docker)

```bash
docker build -t pdu-controller .
docker run --rm -p 3000:3000 --env-file .env pdu-controller
```

Open http://localhost:3000.

## Quick start (local Node.js)

Requires Node.js 22+.

```bash
npm ci
npm start
```

## Configuration

All runtime config comes from environment variables (or `.env` file in the project root).

| Variable                   | Required | Purpose |
| -------------------------- | -------- | ------- |
| `PDU_HOST`                 | yes      | PDU IP or hostname |
| `PDU_SNMP_READ_COMMUNITY`  | yes      | SNMPv2c community for telemetry reads |
| `PDU_SNMP_WRITE_COMMUNITY` | no       | Unused at runtime (see SNMP notes below) |
| `PDU_SNMP_V3_USER`         | yes      | SNMPv3 user for writes |
| `PDU_SNMP_V3_AUTH_PASS`    | yes      | SNMPv3 auth passphrase |
| `PDU_SNMP_V3_PRIV_PASS`    | yes      | SNMPv3 priv passphrase |
| `ELECTRICITY_RATE_ILS_PER_KWH` | no   | Used to project per-outlet monthly cost. Default: 0.61 |
| `AUTH_TOKEN`               | no       | Bearer token. When set, all `/api/*` and `/health/*` calls require `Authorization: Bearer <token>`. |
| `LOG_LEVEL`                | no       | `error` / `warn` / `info` / `debug`. Default: `info` |
| `PORT`                     | no       | HTTP listen port. Default: 3000 |

SNMPv3 auth/priv protocols are hardcoded to MD5 + AES (the only combination the PE8208G responds to).

`.env.example`:

```
PDU_HOST=10.42.2.28
PDU_SNMP_READ_COMMUNITY=public
PDU_SNMP_WRITE_COMMUNITY=private
PDU_SNMP_V3_USER=kolo
PDU_SNMP_V3_AUTH_PASS=changeme
PDU_SNMP_V3_PRIV_PASS=changeme
```

Never commit `.env` — it is listed in `.gitignore` and `.dockerignore`.

## HTTP API

### JSON endpoints (the web UI)

| Method | Path                         | Purpose |
| ------ | ---------------------------- | ------- |
| GET    | `/api/status`                | All 8 outlets: state + voltage/current/power/energy + monthlyCostILS + name. Top-level also includes `rateILSPerKWh`. |
| POST   | `/api/outlet/:n/:action`     | `action` ∈ `on` / `off` / `reboot`, `n` is 1–8 |
| PUT    | `/api/outlet/:n/name`        | Body `{"name":"..."}`, 1–16 chars, `[A-Za-z0-9_ ]` only |

JSON responses. Errors come back as `{"error":"..."}` with an appropriate status code.

### Health endpoints (for monitoring)

Plain-text endpoints intended for probe tools (Uptime Kuma, Prometheus blackbox exporter, curl in a cron, etc.). Status code reflects up/down so the simplest HTTP monitor type works out of the box.

| Method | Path                         | Purpose |
| ------ | ---------------------------- | ------- |
| GET    | `/live`                      | Process liveness only. Always `200 OK`. Unauth. Used by the Docker HEALTHCHECK. |
| GET    | `/health`                    | App + PDU reachability. `200 OK` if the app can talk to the PDU; `503 DOWN <reason>` otherwise. |
| GET    | `/health/outlet/:n`          | Per-outlet *appliance* liveness based on actual power draw (see below). |

When `AUTH_TOKEN` is set, everything except `/live` and the static assets requires the bearer token. `/live` stays unauth so container orchestrators can probe without secrets.

**External monitors (Uptime Kuma etc.)** — add a custom header to each monitor:

| Header name       | Value                    |
| ----------------- | ------------------------ |
| `Authorization`   | `Bearer <your-token>`    |

Uptime Kuma: *Edit monitor → HTTP Options → HTTP Headers → `{"Authorization":"Bearer xxxxxxxx"}`*.

#### Outlet liveness semantics

Energized ≠ alive. A crashed server still has 230 V at the outlet but drops to 0 W. The endpoint compares the *instantaneous draw* against a threshold.

Query parameters (both optional, combined with AND if both set):

| Param   | Unit  | Default  | Meaning |
| ------- | ----- | -------- | ------- |
| `min`   | watts | `1`      | Minimum instantaneous power. Set to `0` to disable the watts check. |
| `min_a` | amps  | `0`      | Minimum instantaneous current. Set this to use an amps threshold. When only `min_a` is provided, the watts default is suppressed. |

Responses (all `text/plain`):

| HTTP | Body                                          | Meaning |
| ---- | --------------------------------------------- | ------- |
| 200  | `LIVE <W>W <A>A min=<x>W min_a=<y>A`          | Appliance is drawing above threshold. |
| 503  | `DOWN <W>W <A>A min=<x>W min_a=<y>A`          | Draw is below threshold (appliance off, crashed, or outlet de-energized). |
| 400  | `INVALID` / `INVALID threshold`               | Bad outlet number or negative/NaN threshold. |
| 502  | `ERROR <reason>`                              | SNMP error talking to the PDU. |

#### Picking a threshold

1 W is permissive — any real load. Tighten per appliance so "running slow / stuck" shows as down too:

| Appliance             | Healthy draw | Suggested URL |
| --------------------- | ------------ | ------------- |
| LED bulb              | ~5 W         | `/health/outlet/3?min=2` |
| Switch / router       | 8–15 W       | `/health/outlet/3?min=5` |
| Small server / NUC    | 30–80 W      | `/health/outlet/3?min=25` |
| Workstation           | 80+ W        | `/health/outlet/3?min=40` |
| Current-sensitive     | any          | `/health/outlet/3?min_a=0.1` |

#### Uptime Kuma setup

- **Monitor type:** HTTP(s)
- **URL:** `https://your-host/health/outlet/<N>?min=<W>`
- **Accepted status codes:** `200-299`
- **Interval:** 30–60 s is fine. Each probe triggers two SNMP GetRequests.

No keyword matching needed — status codes do the work. If you prefer keyword mode, match `LIVE` in the body.

## CI/CD

`.gitlab-ci.yml` builds and pushes a container image to the project's GitLab registry using Kaniko. It runs on every branch push and tag:

- Tagged images: `<SHORT_SHA>` and `<REF_SLUG>` always
- Tagged images: `<GIT_TAG>` and `latest` on tag pushes
- Tagged images: `latest` on default-branch pushes
- Uses `--cache=true --cache-repo=$CI_REGISTRY_IMAGE/cache` for fast incremental builds

No additional GitLab secrets needed — `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD` are injected automatically.

## Mobile / home-screen install

The page is a minimal PWA: `manifest.webmanifest`, theme colors, Apple meta tags, and a full icon set. On iOS, Share → Add to Home Screen launches the app standalone (no Safari chrome, status-bar blended with the app background, safe-area insets respected so the notch doesn't clip content).

Icons are generated by `scripts/gen-icons.mjs` from a single Node script using the `canvas` package. The dep is installed on demand — it is not in `package.json` and does not ship with the runtime image.

```bash
npm install canvas --no-save
node scripts/gen-icons.mjs   # writes PNGs into public/
npm uninstall canvas --no-save
```

Regenerate after tweaking the icon design if the hard-coded SVG path values in the script are changed.

## Graceful shutdown

The server handles SIGINT and SIGTERM: it stops accepting new connections, drains in-flight HTTP requests, closes the SNMP sessions, and exits. There is a 5-second force-exit fallback. Docker and Kubernetes will terminate cleanly on stop/rolling update.

## SNMP reference

The sections below document the SNMP protocol specifics the app depends on. Useful if you need to talk to the device from the command line or port the controller to another language.

### Authentication

The PDU accepts two SNMP profiles, but they are **not** interchangeable:

| Use case                    | Version | Why |
| --------------------------- | ------- | --- |
| Reads (status, telemetry)   | v2c with read community | Simple, no crypto overhead |
| Writes (outlet control, rename) | v3 `authPriv` / MD5 / AES | v2c writes return `notWritable` on outlet command OIDs |

The v3 user must use **MD5 auth and AES privacy**. Other combinations (SHA+AES, MD5+DES, SHA+DES) time out on the PE8208G.

### OID map

All outlet-specific OIDs live under the ATEN enterprise root `1.3.6.1.4.1.21317.1.3.2.2.2`. Two different indexing schemes are in play:

| Purpose                                     | Pattern                      | Outlet 1   | Outlet 4   |
| ------------------------------------------- | ---------------------------- | ---------- | ---------- |
| Outlet command (read-write scalar)          | `.2.<N+1>.0`                 | `.2.2.0`   | `.2.5.0`   |
| Outlet telemetry (read-only table)          | `.2.1.1.<col>.<N>`           | `...2.1`   | `...2.4`   |
| Outlet name (read-write)                    | `.2.10.1.2.<N>`              | `.2.10.1.2.1` | `.2.10.1.2.4` |

Command values: `1`=off, `2`=on, `3`=pending, `4`=reboot, `5`=fault, `6`=noauth, `7`=not-support, `8`=pop.

Telemetry columns:

| Column | Metric | Units |
| ------ | ------ | ----- |
| 2      | Current | A (string) |
| 3      | Voltage | V (string) |
| 4      | Power | W (string) |
| 5      | Energy | kWh (string) |
| 6      | Power factor | integer ×100 |

### Gotchas

- **`notWritable` with v2c write community** — the device rejects community-authenticated writes to outlet OIDs. Always use v3 authPriv for writes.
- **`TooBig` on batched reads** — more than ~40 OIDs in a single `GetRequest` overflows the device's response buffer. The app splits the 48-OID fetch (6 columns × 8 outlets) into two parallel gets.
- **Cached status table `.70.1.2.<N>`** — reports on/off state but updates lag the command OID by a few seconds. For authoritative state, read the per-outlet voltage column (drops to 0.00 V when de-energized).
- **Outlet name charset** — device accepts only `[A-Za-z0-9_ ]`, 1–16 chars. Hyphens, periods, slashes are rejected with `BadValue`. Empty strings are also rejected.
- **Power-on delay** — after an `on` command, the outlet reports state `3` (pending) for ~3 s before settling to `2` (on).

### Manual SNMP examples

Load `.env` into the shell first:

```bash
set -a; . ./.env; set +a
```

Read outlet 4 telemetry:

```bash
snmpget -v2c -c "$PDU_SNMP_READ_COMMUNITY" "$PDU_HOST" \
  1.3.6.1.4.1.21317.1.3.2.2.2.2.1.1.2.4 \
  1.3.6.1.4.1.21317.1.3.2.2.2.2.1.1.3.4 \
  1.3.6.1.4.1.21317.1.3.2.2.2.2.1.1.4.4
```

Turn outlet 4 off:

```bash
snmpset -v3 -l authPriv \
  -u "$PDU_SNMP_V3_USER" \
  -a "$PDU_SNMP_V3_AUTH_PROTO" -A "$PDU_SNMP_V3_AUTH_PASS" \
  -x "$PDU_SNMP_V3_PRIV_PROTO" -X "$PDU_SNMP_V3_PRIV_PASS" \
  "$PDU_HOST" \
  1.3.6.1.4.1.21317.1.3.2.2.2.2.5.0 i 1
```

## Project layout

```
.
├── Dockerfile            multi-stage, node:22-alpine runner
├── .dockerignore
├── .gitlab-ci.yml        Kaniko build & push to project registry
├── package.json          type: module
├── server.js             Express + net-snmp, REST + health API
├── public/
│   ├── index.html        SPA shell + PWA meta tags
│   ├── style.css         mobile-first; 4×2 chassis below 700 px
│   ├── app.js            vanilla JS; polls /api/status every 2 s
│   ├── manifest.webmanifest
│   ├── icon.svg
│   ├── apple-touch-icon.png
│   ├── favicon-32.png
│   ├── icon-192.png
│   ├── icon-512.png
│   └── og-image.png
├── scripts/
│   └── gen-icons.mjs     regenerate the icon set via node-canvas
└── README.md
```

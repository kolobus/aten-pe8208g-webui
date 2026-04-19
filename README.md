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
| `PDU_SNMP_V3_AUTH_PROTO`   | no       | Default: MD5 (device-specific) |
| `PDU_SNMP_V3_PRIV_PROTO`   | no       | Default: AES (device-specific) |
| `PORT`                     | no       | HTTP listen port. Default: 3000 |

`.env.example`:

```
PDU_HOST=10.42.2.28
PDU_SNMP_READ_COMMUNITY=public
PDU_SNMP_WRITE_COMMUNITY=private
PDU_SNMP_V3_USER=kolo
PDU_SNMP_V3_AUTH_PASS=changeme
PDU_SNMP_V3_PRIV_PASS=changeme
PDU_SNMP_V3_AUTH_PROTO=MD5
PDU_SNMP_V3_PRIV_PROTO=AES
```

Never commit `.env` — it is listed in `.gitignore` and `.dockerignore`.

## HTTP API

| Method | Path                         | Purpose |
| ------ | ---------------------------- | ------- |
| GET    | `/api/status`                | All 8 outlets: state + voltage/current/power/energy + name |
| POST   | `/api/outlet/:n/:action`     | `action` ∈ `on` / `off` / `reboot`, `n` is 1–8 |
| PUT    | `/api/outlet/:n/name`        | Body `{"name":"..."}`, 1–16 chars, `[A-Za-z0-9_ ]` only |

All endpoints return JSON. Errors come back as `{"error":"..."}` with appropriate status code.

## CI/CD

`.gitlab-ci.yml` builds and pushes a container image to the project's GitLab registry using Kaniko. It runs on every branch push and tag:

- Tagged images: `<SHORT_SHA>` and `<REF_SLUG>` always
- Tagged images: `<GIT_TAG>` and `latest` on tag pushes
- Tagged images: `latest` on default-branch pushes
- Uses `--cache=true --cache-repo=$CI_REGISTRY_IMAGE/cache` for fast incremental builds

No additional GitLab secrets needed — `CI_REGISTRY_USER` / `CI_REGISTRY_PASSWORD` are injected automatically.

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
├── server.js             Express + net-snmp, REST API
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js            vanilla JS frontend, polls /api/status every 2 s
└── README.md
```

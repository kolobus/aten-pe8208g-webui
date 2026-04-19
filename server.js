import express from 'express';
import snmp from 'net-snmp';
import { createHash, timingSafeEqual } from 'node:crypto';
import 'dotenv/config';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

function log(level, event, ctx = {}) {
  if (LOG_LEVELS[level] > LOG_LEVEL) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...ctx });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

const {
  PDU_HOST,
  PDU_SNMP_READ_COMMUNITY,
  PDU_SNMP_V3_USER,
  PDU_SNMP_V3_AUTH_PASS,
  PDU_SNMP_V3_PRIV_PASS,
} = process.env;

const NUM_OUTLETS = 8;
const ELECTRICITY_RATE = Number.parseFloat(process.env.ELECTRICITY_RATE_ILS_PER_KWH ?? '0.61');
const HOURS_PER_MONTH = 730;
const BASE = '1.3.6.1.4.1.21317.1.3.2.2.2.2';
const commandOid          = n => `${BASE}.${n + 1}.0`;
const currentOid          = n => `${BASE}.1.1.2.${n}`;
const voltageOid          = n => `${BASE}.1.1.3.${n}`;
const powerOid            = n => `${BASE}.1.1.4.${n}`;
const energyOid           = n => `${BASE}.1.1.5.${n}`;
const nameOid             = n => `${BASE}.10.1.2.${n}`;
const shutdownMethodOid   = n => `${BASE}.10.1.6.${n}`;
const macOid              = n => `${BASE}.10.1.7.${n}`;

const SHUTDOWN_METHODS = {
  1: 'kill-the-power',
  2: 'wake-on-lan',
  3: 'after-ac-back',
  4: 'not-support',
};

const NAME_MAX_LEN = 16;
const NAME_RE = /^[A-Za-z0-9_ ]+$/;

const STATE_NAMES = {
  1: 'off', 2: 'on', 3: 'pending', 4: 'reboot',
  5: 'fault', 6: 'noauth', 7: 'not-support', 8: 'pop',
};
const ACTION_VALUES = { on: 2, off: 1, reboot: 4 };

const readSession = snmp.createSession(PDU_HOST, PDU_SNMP_READ_COMMUNITY, {
  version: snmp.Version2c,
});

const writeSession = snmp.createV3Session(PDU_HOST, {
  name: PDU_SNMP_V3_USER,
  level: snmp.SecurityLevel.authPriv,
  authProtocol: snmp.AuthProtocols.md5,
  authKey: PDU_SNMP_V3_AUTH_PASS,
  privProtocol: snmp.PrivProtocols.aes,
  privKey: PDU_SNMP_V3_PRIV_PASS,
});

function snmpGet(session, oids) {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, varbinds) => {
      if (err) return reject(err);
      for (const v of varbinds) {
        if (snmp.isVarbindError(v)) return reject(new Error(snmp.varbindError(v)));
      }
      resolve(varbinds);
    });
  });
}

function snmpSet(session, oid, value, type = snmp.ObjectType.Integer) {
  return new Promise((resolve, reject) => {
    session.set(
      [{ oid, type, value }],
      (err, varbinds) => {
        if (err) return reject(err);
        if (snmp.isVarbindError(varbinds[0])) {
          return reject(new Error(snmp.varbindError(varbinds[0])));
        }
        resolve(varbinds[0]);
      }
    );
  });
}

function toNumber(varbind) {
  const s = varbind.value?.toString?.() ?? '';
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toName(varbind) {
  const buf = varbind.value;
  if (!buf) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  return s.replace(/\0+$/g, '').trim();
}

const AUTH_TOKEN = process.env.AUTH_TOKEN;
const AUTH_ENABLED = Boolean(AUTH_TOKEN);
const AUTH_TOKEN_HASH = AUTH_ENABLED
  ? createHash('sha256').update(AUTH_TOKEN).digest()
  : null;

function tokenMatches(provided) {
  if (!provided) return false;
  const hash = createHash('sha256').update(provided).digest();
  return timingSafeEqual(hash, AUTH_TOKEN_HASH);
}

function requireAuth(req, res, next) {
  if (!AUTH_ENABLED) return next();
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (tokenMatches(token)) {
    log('debug', 'auth.ok', { ip: req.ip, path: req.path });
    return next();
  }
  log('warn', 'auth.fail', {
    ip: req.ip, path: req.path,
    reason: token ? 'bad-token' : 'missing-header',
  });
  res.status(401).type('text/plain').send('Unauthorized');
}

const app = express();
app.set('trust proxy', true);
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
app.use(express.json());
app.use(express.static('public'));

app.get('/live', (_req, res) => res.type('text/plain').send('OK'));

app.use(['/api', '/health'], requireAuth);

const SYS_NAME_OID     = '1.3.6.1.2.1.1.5.0';
const SYS_CONTACT_OID  = '1.3.6.1.2.1.1.4.0';
const SYS_LOCATION_OID = '1.3.6.1.2.1.1.6.0';
const SYS_UPTIME_OID   = '1.3.6.1.2.1.1.3.0';

const DEVICE_FIELDS = {
  name:     { oid: SYS_NAME_OID,     max: 32 },
  contact:  { oid: SYS_CONTACT_OID,  max: 63 },
  location: { oid: SYS_LOCATION_OID, max: 63 },
};
const DEVICE_FIELD_RE = /^[A-Za-z0-9_. ]+$/;

app.put('/api/device/:field', async (req, res) => {
  const f = DEVICE_FIELDS[req.params.field];
  if (!f) return res.status(404).json({ error: 'unknown device field' });
  const v = typeof req.body?.value === 'string' ? req.body.value.trim() : '';
  if (!v || v.length > f.max) {
    return res.status(400).json({ error: `value must be 1–${f.max} chars` });
  }
  if (!DEVICE_FIELD_RE.test(v)) {
    return res.status(400).json({ error: 'letters, digits, underscore, period, space only' });
  }
  try {
    await snmpSet(writeSession, f.oid, Buffer.from(v, 'utf8'), snmp.ObjectType.OctetString);
    log('info', `device.${req.params.field}`, { value: v, ip: req.ip });
    res.json({ ok: true, field: req.params.field, value: v });
  } catch (err) {
    log('error', `device.${req.params.field}.failed`, { value: v, message: err.message });
    res.status(500).json({ error: err.message });
  }
});
const BANK_AMPS_OID    = '1.3.6.1.4.1.21317.1.3.2.2.2.1.3.1.2.1';
const BANK_VOLTS_OID   = '1.3.6.1.4.1.21317.1.3.2.2.2.1.3.1.3.1';
const BANK_WATTS_OID   = '1.3.6.1.4.1.21317.1.3.2.2.2.1.3.1.4.1';
const BANK_KWH_OID     = '1.3.6.1.4.1.21317.1.3.2.2.2.1.3.1.5.1';
const BANK_MAX_AMPS_OID= '1.3.6.1.4.1.21317.1.3.2.2.2.1.3.1.7.1';

app.get('/api/info', async (_req, res) => {
  try {
    const vbs = await snmpGet(readSession, [
      SYS_NAME_OID, SYS_CONTACT_OID, SYS_LOCATION_OID, SYS_UPTIME_OID,
      BANK_AMPS_OID, BANK_VOLTS_OID, BANK_WATTS_OID, BANK_KWH_OID, BANK_MAX_AMPS_OID,
    ]);
    const amps  = toNumber(vbs[4]);
    const watts = toNumber(vbs[6]);
    res.json({
      host: PDU_HOST,
      name: toName(vbs[0]),
      contact: toName(vbs[1]),
      location: toName(vbs[2]),
      uptimeSec: Math.floor((vbs[3].value ?? 0) / 100),
      bank: {
        amps,
        volts:  toNumber(vbs[5]),
        watts,
        kwh:    toNumber(vbs[7]),
        maxAmps: vbs[8].value,
        monthlyCostILS: Number.isFinite(watts) ? (watts * HOURS_PER_MONTH / 1000) * ELECTRICITY_RATE : null,
      },
    });
  } catch (err) {
    log('error', 'info.failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', async (_req, res) => {
  try {
    const oids = [];
    for (let n = 1; n <= NUM_OUTLETS; n++) {
      oids.push(
        commandOid(n), currentOid(n), voltageOid(n), powerOid(n), energyOid(n),
        nameOid(n), shutdownMethodOid(n), macOid(n),
      );
    }
    const COLS = 8;
    const CHUNK = 24;
    const chunks = [];
    for (let i = 0; i < oids.length; i += CHUNK) chunks.push(oids.slice(i, i + CHUNK));
    const responses = await Promise.all(chunks.map(c => snmpGet(readSession, c)));
    const vbs = responses.flat();

    const outlets = [];
    for (let i = 0; i < NUM_OUTLETS; i++) {
      const base = i * COLS;
      const power = toNumber(vbs[base + 3]);
      const sm = vbs[base + 6].value;
      outlets.push({
        outlet: i + 1,
        name: toName(vbs[base + 5]),
        state: STATE_NAMES[vbs[base].value] || `unknown(${vbs[base].value})`,
        current: toNumber(vbs[base + 1]),
        voltage: toNumber(vbs[base + 2]),
        power,
        energy: toNumber(vbs[base + 4]),
        monthlyCostILS: Number.isFinite(power) ? (power * HOURS_PER_MONTH / 1000) * ELECTRICITY_RATE : null,
        shutdownMethod: SHUTDOWN_METHODS[sm] || `unknown(${sm})`,
        mac: toName(vbs[base + 7]),
        locked: lockedOutlets.has(i + 1),
      });
    }
    res.json({ host: PDU_HOST, rateILSPerKWh: ELECTRICITY_RATE, outlets });
  } catch (err) {
    log('error', 'status.failed', { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

const confirmationOid = n => `${BASE}.10.1.3.${n}`;
const CONFIRMATION_LOCKED = 2;
const CONFIRMATION_UNLOCKED = 1;
const lockedOutlets = new Set();

async function loadLockedOutlets() {
  try {
    const oids = [];
    for (let n = 1; n <= NUM_OUTLETS; n++) oids.push(confirmationOid(n));
    const vbs = await snmpGet(readSession, oids);
    lockedOutlets.clear();
    for (let i = 0; i < NUM_OUTLETS; i++) {
      if (vbs[i].value === CONFIRMATION_LOCKED) lockedOutlets.add(i + 1);
    }
    log('info', 'lock.loaded', { locked: [...lockedOutlets] });
  } catch (err) {
    log('warn', 'lock.load.failed', { message: err.message });
  }
}

function rejectIfLocked(req, res, next) {
  const n = Number.parseInt(req.params.n, 10);
  if (lockedOutlets.has(n)) {
    log('warn', 'outlet.locked.rejected', { outlet: n, path: req.path, ip: req.ip });
    return res.status(409).json({ error: 'outlet is locked' });
  }
  next();
}

const HEALTH_TTL_MS = 5000;
const healthCache = new Map();

async function memoize(key, compute) {
  const now = Date.now();
  const hit = healthCache.get(key);
  if (hit && hit.expires > now) return hit.promise;
  const promise = compute();
  healthCache.set(key, { promise, expires: now + HEALTH_TTL_MS });
  try { await promise; } catch (err) { healthCache.delete(key); throw err; }
  return promise;
}

app.get('/health', async (_req, res) => {
  try {
    const body = await memoize('health', async () => {
      await snmpGet(readSession, ['1.3.6.1.2.1.1.5.0']);
      return 'OK';
    });
    res.type('text/plain').send(body);
  } catch (err) {
    log('error', 'health.failed', { message: err?.message });
    res.status(503).type('text/plain').send('DOWN');
  }
});

app.get('/health/outlet/:n', async (req, res) => {
  const n = Number.parseInt(req.params.n, 10);
  const hasMinA = req.query.min_a !== undefined;
  const min = Number.parseFloat(req.query.min ?? (hasMinA ? '0' : '1'));
  const minA = Number.parseFloat(req.query.min_a ?? '0');
  if (!Number.isInteger(n) || n < 1 || n > NUM_OUTLETS) {
    return res.status(400).type('text/plain').send('INVALID');
  }
  if (!Number.isFinite(min) || min < 0 || !Number.isFinite(minA) || minA < 0) {
    return res.status(400).type('text/plain').send('INVALID threshold');
  }
  try {
    const { status, body } = await memoize(`outlet:${n}:${min}:${minA}`, async () => {
      const vbs = await snmpGet(readSession, [currentOid(n), powerOid(n)]);
      const amps = toNumber(vbs[0]);
      const watts = toNumber(vbs[1]);
      const live =
        Number.isFinite(watts) && watts >= min &&
        Number.isFinite(amps)  && amps  >= minA;
      return {
        status: live ? 200 : 503,
        body: `${live ? 'LIVE' : 'DOWN'} ${(watts ?? 0).toFixed(1)}W ${(amps ?? 0).toFixed(2)}A min=${min}W min_a=${minA}A`,
      };
    });
    res.status(status).type('text/plain').send(body);
  } catch (err) {
    log('error', 'health.outlet.failed', { outlet: n, message: err?.message });
    res.status(502).type('text/plain').send('ERROR');
  }
});

const MAC_RE = /^[0-9A-Fa-f]{12}$/;
const SHUTDOWN_METHOD_TO_INT = {
  'kill-the-power': 1,
  'wake-on-lan':    2,
  'after-ac-back':  3,
};

app.put('/api/outlet/:n/lock', async (req, res) => {
  const n = Number.parseInt(req.params.n, 10);
  const want = Boolean(req.body?.locked);
  if (!Number.isInteger(n) || n < 1 || n > NUM_OUTLETS) {
    return res.status(400).json({ error: 'invalid outlet' });
  }
  const value = want ? CONFIRMATION_LOCKED : CONFIRMATION_UNLOCKED;
  try {
    await snmpSet(writeSession, confirmationOid(n), value);
    if (want) lockedOutlets.add(n); else lockedOutlets.delete(n);
    log('info', 'outlet.lock', { outlet: n, locked: want, ip: req.ip });
    res.json({ ok: true, outlet: n, locked: want });
  } catch (err) {
    log('error', 'outlet.lock.failed', { outlet: n, locked: want, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/outlet/:n/mac', rejectIfLocked, async (req, res) => {
  const n = Number.parseInt(req.params.n, 10);
  const raw = typeof req.body?.mac === 'string' ? req.body.mac.replace(/[\s:.\-]/g, '').toUpperCase() : '';
  if (!Number.isInteger(n) || n < 1 || n > NUM_OUTLETS) {
    return res.status(400).json({ error: 'invalid outlet' });
  }
  if (!MAC_RE.test(raw)) {
    return res.status(400).json({ error: 'mac must be 12 hex chars (separators allowed)' });
  }
  try {
    await snmpSet(writeSession, macOid(n), Buffer.from(raw, 'utf8'), snmp.ObjectType.OctetString);
    log('info', 'outlet.mac', { outlet: n, mac: raw, ip: req.ip });
    res.json({ ok: true, outlet: n, mac: raw });
  } catch (err) {
    log('error', 'outlet.mac.failed', { outlet: n, mac: raw, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/outlet/:n/shutdown-method', rejectIfLocked, async (req, res) => {
  const n = Number.parseInt(req.params.n, 10);
  const method = req.body?.method;
  const value = SHUTDOWN_METHOD_TO_INT[method];
  if (!Number.isInteger(n) || n < 1 || n > NUM_OUTLETS) {
    return res.status(400).json({ error: 'invalid outlet' });
  }
  if (!value) {
    return res.status(400).json({ error: `method must be one of ${Object.keys(SHUTDOWN_METHOD_TO_INT).join(', ')}` });
  }
  try {
    await snmpSet(writeSession, shutdownMethodOid(n), value);
    log('info', 'outlet.shutdown-method', { outlet: n, method, ip: req.ip });
    res.json({ ok: true, outlet: n, method });
  } catch (err) {
    log('error', 'outlet.shutdown-method.failed', { outlet: n, method, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/outlet/:n/name', rejectIfLocked, async (req, res) => {
  const n = Number.parseInt(req.params.n, 10);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!Number.isInteger(n) || n < 1 || n > NUM_OUTLETS) {
    return res.status(400).json({ error: 'invalid outlet' });
  }
  if (name.length < 1 || name.length > NAME_MAX_LEN) {
    return res.status(400).json({ error: `name must be 1–${NAME_MAX_LEN} chars` });
  }
  if (!NAME_RE.test(name)) {
    return res.status(400).json({ error: 'name: letters, digits, underscore, space only' });
  }
  try {
    await snmpSet(writeSession, nameOid(n), Buffer.from(name, 'utf8'), snmp.ObjectType.OctetString);
    log('info', 'outlet.rename', { outlet: n, name, ip: req.ip });
    res.json({ ok: true, outlet: n, name });
  } catch (err) {
    log('error', 'outlet.rename.failed', { outlet: n, name, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/outlet/:n/:action', rejectIfLocked, async (req, res) => {
  const n = Number.parseInt(req.params.n, 10);
  const value = ACTION_VALUES[req.params.action];
  if (!Number.isInteger(n) || n < 1 || n > NUM_OUTLETS) {
    return res.status(400).json({ error: 'invalid outlet' });
  }
  if (value === undefined) {
    return res.status(400).json({ error: 'invalid action (on|off|reboot)' });
  }
  try {
    await snmpSet(writeSession, commandOid(n), value);
    log('info', 'outlet.action', { outlet: n, action: req.params.action, ip: req.ip });
    res.json({ ok: true, outlet: n, action: req.params.action });
  } catch (err) {
    log('error', 'outlet.action.failed', {
      outlet: n, action: req.params.action, message: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);

let server;

async function main() {
  try {
    await snmpGet(readSession, ['1.3.6.1.2.1.1.5.0']);
    log('info', 'pdu.reachable', { host: PDU_HOST });
  } catch (err) {
    log('error', 'pdu.unreachable', {
      host: PDU_HOST,
      message: err.message,
      hint: 'Verify PDU_HOST, network route, and PDU_SNMP_READ_COMMUNITY',
    });
    process.exit(1);
  }

  await loadLockedOutlets();

  server = app.listen(PORT, () => {
    log('info', 'server.start', { port: PORT, auth: AUTH_ENABLED, logLevel: Object.keys(LOG_LEVELS)[LOG_LEVEL] });
  });
}

main();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', 'server.shutdown', { signal });

  const force = setTimeout(() => {
    log('error', 'server.shutdown.forced', {});
    process.exit(1);
  }, 5000).unref();

  if (!server) { process.exit(0); }
  server.close(err => {
    readSession.close();
    writeSession.close();
    clearTimeout(force);
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

import express from 'express';
import snmp from 'net-snmp';
import 'dotenv/config';

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
const commandOid = n => `${BASE}.${n + 1}.0`;
const currentOid = n => `${BASE}.1.1.2.${n}`;
const voltageOid = n => `${BASE}.1.1.3.${n}`;
const powerOid   = n => `${BASE}.1.1.4.${n}`;
const energyOid  = n => `${BASE}.1.1.5.${n}`;
const nameOid    = n => `${BASE}.10.1.2.${n}`;

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

const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/api/status', async (_req, res) => {
  try {
    const oids = [];
    for (let n = 1; n <= NUM_OUTLETS; n++) {
      oids.push(commandOid(n), currentOid(n), voltageOid(n), powerOid(n), energyOid(n), nameOid(n));
    }
    const HALF = oids.length / 2;
    const [first, second] = await Promise.all([
      snmpGet(readSession, oids.slice(0, HALF)),
      snmpGet(readSession, oids.slice(HALF)),
    ]);
    const vbs = first.concat(second);
    const outlets = [];
    const COLS = 6;
    for (let i = 0; i < NUM_OUTLETS; i++) {
      const base = i * COLS;
      const power = toNumber(vbs[base + 3]);
      outlets.push({
        outlet: i + 1,
        name: toName(vbs[base + 5]),
        state: STATE_NAMES[vbs[base].value] || `unknown(${vbs[base].value})`,
        current: toNumber(vbs[base + 1]),
        voltage: toNumber(vbs[base + 2]),
        power,
        energy: toNumber(vbs[base + 4]),
        monthlyCostILS: Number.isFinite(power) ? (power * HOURS_PER_MONTH / 1000) * ELECTRICITY_RATE : null,
      });
    }
    res.json({ host: PDU_HOST, rateILSPerKWh: ELECTRICITY_RATE, outlets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/outlet/:n/name', async (req, res) => {
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
    res.json({ ok: true, outlet: n, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/outlet/:n/:action', async (req, res) => {
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
    res.json({ ok: true, outlet: n, action: req.params.action });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number.parseInt(process.env.PORT ?? '3000', 10);
const server = app.listen(PORT, () => {
  console.log(`PDU controller listening on http://localhost:${PORT}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down…`);

  const force = setTimeout(() => {
    console.error('forced exit after 5s');
    process.exit(1);
  }, 5000).unref();

  server.close(err => {
    readSession.close();
    writeSession.close();
    clearTimeout(force);
    process.exit(err ? 1 : 0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

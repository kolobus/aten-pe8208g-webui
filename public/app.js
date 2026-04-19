const POLL_MS = 10000;

const SHORT_NAMES = {
  'kill-the-power': 'KILL',
  'wake-on-lan':    'WOL',
  'after-ac-back':  'AC-BACK',
};
const MODE_DESCRIPTIONS = {
  'kill-the-power': 'Default. Off command cuts power immediately; on command restores it immediately.',
  'wake-on-lan':    'Off command first asks ATEN\u2019s Safe-Shutdown agent on the host to shut down cleanly, then waits the off-delay before cutting power. On command sends a Wake-on-LAN magic packet to the outlet\u2019s MAC. Useless without the agent installed on the connected machine.',
  'after-ac-back':  'Off command does NOT cut power immediately — it defers the shutdown until the next AC power event (e.g. utility blip). Niche scheduling helper, NOT what controls automatic restore-on-power-return; that lives in the PDU\u2019s firmware Power Recovery setting (web UI only).',
};
const outletsEl = document.getElementById('outlets');
const tbodyEl = document.getElementById('telemetry-body');
const metaEl = document.getElementById('meta');
const deviceIdEl = document.getElementById('device-id');
const deviceBrandEl = document.getElementById('device-brand');
const statUptimeEl = document.getElementById('stat-uptime');
const statBankEl = document.getElementById('stat-bank');
const costHeaderEl = document.getElementById('th-cost');

let currencySymbol = '\u20aa';
const loginDialog = document.getElementById('login-dialog');
const loginForm = document.getElementById('login-form');
const loginMsg = document.getElementById('login-msg');
const confirmDialog = document.getElementById('confirm-dialog');
const confirmForm = document.getElementById('confirm-form');
const confirmMsg = document.getElementById('confirm-msg');
const textDialog = document.getElementById('text-dialog');
const textForm = document.getElementById('text-form');
const textTitle = document.getElementById('text-title');
const textMsg = document.getElementById('text-msg');
const textLabel = document.getElementById('text-label');
const modeDialog = document.getElementById('mode-dialog');
const modeMsg = document.getElementById('mode-msg');
const modeOptions = document.getElementById('mode-options');

function pencilIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '12');
  svg.setAttribute('height', '12');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z');
  svg.appendChild(p);
  return svg;
}

function makeEditButton(onClick) {
  const btn = el('button', { cls: 'edit-btn', title: 'Rename' });
  btn.type = 'button';
  btn.appendChild(pencilIcon());
  btn.addEventListener('click', ev => { ev.stopPropagation(); onClick(); });
  return btn;
}

function lockIcon(locked) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  body.setAttribute('x', '4'); body.setAttribute('y', '11');
  body.setAttribute('width', '16'); body.setAttribute('height', '10');
  body.setAttribute('rx', '2');
  svg.appendChild(body);
  const shackle = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shackle.setAttribute('d', locked
    ? 'M 8 11 V 7 a 4 4 0 0 1 8 0 v 4'
    : 'M 8 11 V 7 a 4 4 0 0 1 8 0');
  svg.appendChild(shackle);
  return svg;
}

async function toggleLock(n, locked) {
  metaEl.textContent = `outlet ${n} → ${locked ? 'lock' : 'unlock'}…`;
  try {
    const res = await apiFetch(`/api/outlet/${n}/lock`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locked }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fetchStatus();
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

async function editTextModal({ title, hint, label, value, maxLength, validate }) {
  const input = textForm.querySelector('input[name="value"]');
  textTitle.textContent = title;
  textLabel.textContent = label;
  textMsg.textContent = hint;
  textMsg.style.color = '';
  input.value = value || '';
  if (maxLength) input.setAttribute('maxlength', String(maxLength));
  else input.removeAttribute('maxlength');
  textDialog.showModal();
  input.focus(); input.select();

  return new Promise(resolve => {
    const cancelBtn = textForm.querySelector('[data-role="cancel"]');
    const cleanup = () => {
      textForm.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      textDialog.close();
    };
    function onSubmit(ev) {
      ev.preventDefault();
      const v = input.value.trim();
      const err = validate(v);
      if (err) {
        textMsg.textContent = err;
        textMsg.style.color = 'var(--fault)';
        return;
      }
      cleanup();
      resolve(v);
    }
    function onCancel() { cleanup(); resolve(null); }
    textForm.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function handleRename(n, current) {
  const next = await editTextModal({
    title: 'Rename outlet',
    label: 'Name',
    hint: `Outlet ${n} · letters, digits, _ , space · 1–16 chars`,
    value: current || '',
    maxLength: 16,
    validate: v => {
      if (!v) return 'name required';
      if (v.length > 16) return 'max 16 characters';
      if (!NAME_RE.test(v)) return 'letters, digits, _ , space only';
      return null;
    },
  });
  if (!next || next === (current || '')) return;
  renameOutlet(n, next);
}

const MAC_INPUT_RE = /^[0-9A-Fa-f]{12}$/;

async function handleMacEdit(n, current) {
  const display = current && current !== '000000000000'
    ? current.match(/.{2}/g).join(':').toUpperCase()
    : '';
  const next = await editTextModal({
    title: 'Set outlet MAC',
    label: 'MAC address',
    hint: `Outlet ${n} · 12 hex chars · separators (: . -) optional · used for Wake-on-LAN`,
    value: display,
    maxLength: 17,
    validate: v => {
      const stripped = v.replace(/[\s:.\-]/g, '');
      if (!MAC_INPUT_RE.test(stripped)) return 'must be 12 hex chars (AA:BB:CC:DD:EE:FF or AABBCCDDEEFF)';
      return null;
    },
  });
  if (!next) return;
  const stripped = next.replace(/[\s:.\-]/g, '').toUpperCase();
  if (stripped === (current || '').toUpperCase()) return;
  setOutletMac(n, stripped);
}

async function setOutletMac(n, mac) {
  metaEl.textContent = `outlet ${n} → MAC ${mac}…`;
  try {
    const res = await apiFetch(`/api/outlet/${n}/mac`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mac }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fetchStatus();
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

async function handleModeChange(outlet, name, current) {
  modeMsg.textContent = name
    ? `Outlet "${name}" — current: ${SHORT_NAMES[current] ?? current}`
    : `Outlet ${outlet} — current: ${SHORT_NAMES[current] ?? current}`;
  modeOptions.replaceChildren();

  const choice = await new Promise(resolve => {
    const cancelBtn = modeDialog.querySelector('[data-role="cancel"]');
    const cleanup = () => {
      cancelBtn.removeEventListener('click', onCancel);
      modeDialog.close();
    };
    function onCancel() { cleanup(); resolve(null); }
    cancelBtn.addEventListener('click', onCancel);

    for (const [v, short] of Object.entries(SHORT_NAMES)) {
      const isCurrent = v === current;
      const btn = el('button', { cls: `mode-option${isCurrent ? ' current' : ''}` });
      btn.type = 'button';
      btn.appendChild(el('span', { cls: 'mode-short', text: short }));
      btn.appendChild(el('span', { cls: 'mode-name', text: v }));
      btn.appendChild(el('span', { cls: 'mode-desc', text: MODE_DESCRIPTIONS[v] }));
      if (isCurrent) btn.disabled = true;
      btn.addEventListener('click', () => { cleanup(); resolve(v); });
      modeOptions.appendChild(btn);
    }
    modeDialog.showModal();
  });

  if (!choice || choice === current) return;
  setShutdownMethod(outlet, choice);
}

async function setShutdownMethod(n, method) {
  metaEl.textContent = `outlet ${n} → shutdown ${method}…`;
  try {
    const res = await apiFetch(`/api/outlet/${n}/shutdown-method`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fetchStatus();
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

let lastOutlets = [];

function outletByNum(n) {
  return lastOutlets.find(o => o.outlet === n);
}

function confirmDestructive(message) {
  confirmMsg.textContent = message;
  confirmDialog.showModal();
  return new Promise(resolve => {
    const onSubmit = ev => { ev.preventDefault(); cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const cancelBtn = confirmForm.querySelector('[data-role="cancel"]');
    function cleanup() {
      confirmForm.removeEventListener('submit', onSubmit);
      cancelBtn.removeEventListener('click', onCancel);
      confirmDialog.close();
    }
    confirmForm.addEventListener('submit', onSubmit);
    cancelBtn.addEventListener('click', onCancel);
  });
}

const AUTH_KEY = 'pdu_token';

function getAuthHeader() {
  const v = localStorage.getItem(AUTH_KEY);
  return v ? { Authorization: 'Bearer ' + v } : {};
}

function setAuth(token) {
  localStorage.setItem(AUTH_KEY, token);
}

function clearAuth() {
  localStorage.removeItem(AUTH_KEY);
}

async function apiFetch(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { ...getAuthHeader(), ...(init.headers || {}) },
  });
  if (res.status === 401) {
    clearAuth();
    document.body.classList.remove('ready');
    await promptLogin();
    return apiFetch(url, init);
  }
  return res;
}

function promptLogin(message = 'Authentication required.') {
  loginMsg.textContent = message;
  if (!loginDialog.open) loginDialog.showModal();
  return new Promise(resolve => {
    loginForm.addEventListener('submit', function handler(ev) {
      ev.preventDefault();
      const fd = new FormData(loginForm);
      const token = fd.get('token')?.toString().trim();
      if (!token) return;
      setAuth(token);
      loginForm.reset();
      loginForm.removeEventListener('submit', handler);
      loginDialog.close();
      resolve();
    }, { once: true });
  });
}

function fmt(n, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

function el(tag, { cls, text, title } = {}, ...children) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  if (title) node.title = title;
  for (const c of children) if (c != null) node.appendChild(c);
  return node;
}

function buildCard(o) {
  const socketCls = o.outlet === 1 ? 'socket c19' : 'socket c13';
  const socket = el('div', { cls: socketCls },
    el('span', { cls: 'pin l' }),
    el('span', { cls: 'pin r' }),
    el('span', { cls: 'pin g' }),
  );
  if (!o.locked) {
    socket.addEventListener('click', () => {
      if (o.state === 'on') controlOutlet(o.outlet, 'off');
      else if (o.state === 'off') controlOutlet(o.outlet, 'on');
    });
  }

  const nameEl = el('div', { cls: 'outlet-name' },
    el('span', { cls: 'name-text', text: o.name || '—' }),
  );
  if (o.locked) {
    const lh = el('span', { cls: 'lock-hint', title: 'Locked' });
    lh.appendChild(lockIcon(true));
    nameEl.appendChild(lh);
  }

  const readouts = el('div', { cls: 'readouts' },
    el('span', { text: `${fmt(o.current, 2)}A` }),
    el('span', { cls: 'meta-sep', text: ' · ' }),
    el('span', { text: `${fmt(o.power, 1)}W` }),
  );
  return el('div', {
    cls: `outlet ${o.state}${o.locked ? ' locked' : ''}`,
    title: `Outlet ${o.outlet}: ${o.name || ''}${o.locked ? ' (locked)' : ''}`,
  }, nameEl, socket, readouts);
}

function buildRow(o) {
  const nextAction = o.state === 'on' ? 'off' : 'on';
  const toggle = el('button', {
    cls: `toggle ${o.state === 'on' ? 'danger' : ''}`,
    text: `TURN ${nextAction.toUpperCase()}`,
  });
  toggle.addEventListener('click', () => controlOutlet(o.outlet, nextAction));

  const reboot = o.state === 'on'
    ? el('button', { cls: 'toggle warn', text: 'REBOOT', title: 'Power-cycle this outlet' })
    : null;
  if (reboot) reboot.addEventListener('click', () => controlOutlet(o.outlet, 'reboot'));

  const macFmt = (o.mac || '000000000000').match(/.{2}/g).join(':').toUpperCase();

  const nameRow = el('div', { cls: 'name-row' },
    el('span', { cls: 'name-text', text: o.name || '—' }),
    o.locked ? null : makeEditButton(() => handleRename(o.outlet, o.name)),
  );
  if (o.locked) {
    const lockHint = el('span', { cls: 'lock-hint', title: 'Locked' });
    lockHint.appendChild(lockIcon(true));
    nameRow.appendChild(lockHint);
  }
  const nameCell = el('td', { cls: 'name-cell' },
    nameRow,
    el('div', { cls: 'name-meta' },
      el('span', { text: macFmt }),
      o.locked ? null : makeEditButton(() => handleMacEdit(o.outlet, o.mac)),
    ),
  );

  const lockBtn = el('button', {
    cls: o.locked ? 'toggle lock-action locked' : 'toggle lock-action',
    text: o.locked ? 'UNLOCK' : 'LOCK',
    title: o.locked ? 'Unlock outlet' : 'Lock outlet — disables all controls',
  });
  lockBtn.type = 'button';
  lockBtn.addEventListener('click', async () => {
    const want = !o.locked;
    const label = o.name ? `"${o.name}"` : `outlet ${o.outlet}`;
    const msg = want
      ? `Lock ${label}?\n\nWhile locked, on/off/reboot/rename/MAC/mode are disabled — both in the UI and over the API. Use this to protect production loads from accidental toggling.`
      : `Unlock ${label}?\n\nThis outlet was locked for a reason — usually to protect a critical load from accidental power cycling. An unintended off click later could mean a drive to the datacenter. Continue only if you really want to allow toggling again.`;
    const ok = await confirmDestructive(msg);
    if (ok) toggleLock(o.outlet, want);
  });

  const actionCell = el('td', { cls: 'action-cell' });
  if (o.locked) {
    actionCell.appendChild(lockBtn);
  } else {
    const modeBtn = el('button', {
      cls: 'toggle mode',
      text: SHORT_NAMES[o.shutdownMethod] ?? '?',
      title: `Shutdown mode: ${o.shutdownMethod}`,
    });
    modeBtn.type = 'button';
    modeBtn.addEventListener('click', () => handleModeChange(o.outlet, o.name, o.shutdownMethod));
    actionCell.appendChild(toggle);
    if (reboot) actionCell.appendChild(reboot);
    actionCell.appendChild(modeBtn);
    actionCell.appendChild(lockBtn);
  }

  return el('tr', { cls: `row-${o.state}`, title: `state: ${o.state}` },
    el('td', { text: String(o.outlet) }),
    nameCell,
    el('td', { text: fmt(o.voltage, 2) }),
    el('td', { text: fmt(o.current, 2) }),
    el('td', { text: fmt(o.power, 2) }),
    el('td', { text: fmt(o.monthlyCost, 2) }),
    actionCell,
  );
}

const NAME_RE = /^[A-Za-z0-9_ ]+$/;

async function renameOutlet(n, name) {
  metaEl.textContent = `renaming outlet ${n}…`;
  try {
    const res = await apiFetch(`/api/outlet/${n}/name`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fetchStatus();
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

function render(data) {
  lastOutlets = data.outlets;
  const active = document.activeElement;
  if (active && active.classList?.contains('name-input')) return;
  outletsEl.replaceChildren(...data.outlets.map(buildCard));
  tbodyEl.replaceChildren(...data.outlets.map(buildRow));
}

async function fetchStatus() {
  try {
    const res = await apiFetch('/api/status');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    render(data);
    document.body.classList.add('ready');
    metaEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
    metaEl.style.color = '';
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

async function controlOutlet(n, action) {
  const o = outletByNum(n);
  const label = o?.name ? `"${o.name}"` : `outlet ${n}`;
  const draw = Number.isFinite(o?.power) && o.power > 0 ? ` drawing ${o.power.toFixed(1)} W` : '';
  const verbs = { on: 'Turn ON', off: 'Turn OFF', reboot: 'REBOOT' };
  const ok = await confirmDestructive(`${verbs[action] ?? action.toUpperCase()} ${label}${draw}?`);
  if (!ok) return;
  metaEl.textContent = `outlet ${n} → ${action}…`;
  try {
    const res = await apiFetch(`/api/outlet/${n}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTimeout(fetchStatus, 600);
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

function isMeaningful(s) { return typeof s === 'string' && s && s !== '.'; }

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

const DEVICE_FIELD_UI = {
  name:     { title: 'Device name',     label: 'Name',     hint: 'sysName · 1\u201332 chars · letters, digits, _ , . , space', max: 32 },
  contact:  { title: 'Device contact',  label: 'Contact',  hint: 'sysContact · 1\u201363 chars · letters, digits, _ , . , space', max: 63 },
  location: { title: 'Device location', label: 'Location', hint: 'sysLocation · 1\u201363 chars · letters, digits, _ , . , space', max: 63 },
};
const DEVICE_FIELD_RE = /^[A-Za-z0-9_. ]+$/;

async function editDeviceField(field, current) {
  const cfg = DEVICE_FIELD_UI[field];
  const next = await editTextModal({
    title: cfg.title,
    label: cfg.label,
    hint: cfg.hint,
    value: isMeaningful(current) ? current : '',
    maxLength: cfg.max,
    validate: v => {
      if (!v) return `${cfg.label.toLowerCase()} required`;
      if (v.length > cfg.max) return `max ${cfg.max} characters`;
      if (!DEVICE_FIELD_RE.test(v)) return 'letters, digits, _ , . , space only';
      return null;
    },
  });
  if (!next || next === current) return;
  await setDeviceField(field, next);
}

async function setDeviceField(field, value) {
  metaEl.textContent = `device ${field} \u2192 ${value}\u2026`;
  try {
    const res = await apiFetch(`/api/device/${field}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    fetchInfo();
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

function deviceFieldSpan(field, value) {
  const span = el('span', {
    cls: 'device-field editable',
    text: isMeaningful(value) ? value : '\u2014',
    title: `Click to edit ${field}`,
  });
  span.addEventListener('click', () => editDeviceField(field, value));
  return span;
}

async function fetchInfo() {
  try {
    const res = await apiFetch('/api/info');
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    if (data.currency) currencySymbol = data.currency;
    if (costHeaderEl) costHeaderEl.textContent = `${currencySymbol}/mo`;

    deviceBrandEl.replaceChildren(deviceFieldSpan('name', data.name));
    const sep = () => el('span', { cls: 'stat-sep', text: ' \u00b7 ' });
    deviceIdEl.replaceChildren(
      deviceFieldSpan('contact', data.contact),
      sep(),
      deviceFieldSpan('location', data.location),
      sep(),
      el('span', { cls: 'device-host', text: data.host || '\u2014' }),
    );

    statUptimeEl.textContent = `up ${formatUptime(data.uptimeSec)}`;
    const b = data.bank;
    const parts = [];
    if (Number.isFinite(b.amps) && b.maxAmps) parts.push(`${b.amps.toFixed(2)} A / ${b.maxAmps} A`);
    if (Number.isFinite(b.watts)) parts.push(`${b.watts.toFixed(0)} W`);
    if (Number.isFinite(b.kwh)) parts.push(`${b.kwh.toFixed(2)} kWh`);
    if (Number.isFinite(data.ratePerKWh)) parts.push(`${currencySymbol} ${data.ratePerKWh.toFixed(2)}/kWh`);
    if (Number.isFinite(b.monthlyCost)) parts.push(`${currencySymbol} ${b.monthlyCost.toFixed(2)}/mo`);
    statBankEl.textContent = parts.join(' \u00b7 ');
  } catch (err) {
    statUptimeEl.textContent = `error: ${err.message}`;
  }
}

async function init() {
  await fetchStatus();
  fetchInfo();
  setInterval(fetchStatus, POLL_MS);
}
init();

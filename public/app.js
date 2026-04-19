const POLL_MS = 2000;
const outletsEl = document.getElementById('outlets');
const tbodyEl = document.getElementById('telemetry-body');
const metaEl = document.getElementById('meta');
const hostEl = document.getElementById('host');

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
  socket.addEventListener('click', () => {
    if (o.state === 'on') controlOutlet(o.outlet, 'off');
    else if (o.state === 'off') controlOutlet(o.outlet, 'on');
  });

  const nameLabel = el('div', {
    cls: 'outlet-name',
    text: o.name || '—',
    title: 'click to rename',
  });
  nameLabel.addEventListener('click', () => promptRename(o.outlet, o.name));

  const readouts = el('div', { cls: 'readouts' },
    el('div', { cls: 'v', text: `${fmt(o.voltage, 1)} V` }),
    el('div', { text: `${fmt(o.current, 2)} A · ${fmt(o.power, 1)} W` }),
  );
  return el('div', { cls: `outlet ${o.state}`, title: `Outlet ${o.outlet}` },
    el('div', { cls: 'outlet-num', text: `OUT ${o.outlet}` }),
    socket,
    el('div', { cls: 'led' }),
    nameLabel,
    readouts,
  );
}

function buildRow(o) {
  const nextAction = o.state === 'on' ? 'off' : 'on';
  const btn = el('button', {
    cls: `toggle ${o.state === 'on' ? 'danger' : ''}`,
    text: `TURN ${nextAction.toUpperCase()}`,
  });
  btn.addEventListener('click', () => controlOutlet(o.outlet, nextAction));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'name-input';
  nameInput.maxLength = 16;
  nameInput.value = o.name || '';
  nameInput.placeholder = '—';
  nameInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter') ev.target.blur();
    if (ev.key === 'Escape') { ev.target.value = o.name || ''; ev.target.blur(); }
  });
  nameInput.addEventListener('blur', ev => {
    const next = ev.target.value.trim();
    if (!next || next === (o.name || '')) {
      ev.target.value = o.name || '';
      return;
    }
    if (!NAME_RE.test(next) || next.length > 16) {
      metaEl.textContent = 'invalid name — letters/digits/_/space only';
      metaEl.style.color = '#ef4444';
      ev.target.value = o.name || '';
      return;
    }
    renameOutlet(o.outlet, next);
  });

  return el('tr', {},
    el('td', { text: String(o.outlet) }),
    el('td', {}, nameInput),
    el('td', { cls: `state-${o.state}`, text: o.state.toUpperCase() }),
    el('td', { text: fmt(o.voltage, 2) }),
    el('td', { text: fmt(o.current, 2) }),
    el('td', { text: fmt(o.power, 3) }),
    el('td', { text: fmt(o.energy, 4) }),
    el('td', {}, btn),
  );
}

const NAME_RE = /^[A-Za-z0-9_ ]+$/;

function promptRename(n, current) {
  const next = window.prompt(`Rename outlet ${n}\n(1–16 chars, letters/digits/_/space):`, current || '');
  if (next == null) return;
  const trimmed = next.trim();
  if (!trimmed) return;
  if (!NAME_RE.test(trimmed) || trimmed.length > 16) {
    window.alert('invalid name — use only letters, digits, underscore, space (≤16 chars)');
    return;
  }
  renameOutlet(n, trimmed);
}

async function renameOutlet(n, name) {
  metaEl.textContent = `renaming outlet ${n}…`;
  try {
    const res = await fetch(`/api/outlet/${n}/name`, {
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
  hostEl.textContent = data.host || '';
  const active = document.activeElement;
  if (active && active.classList?.contains('name-input')) return;
  outletsEl.replaceChildren(...data.outlets.map(buildCard));
  tbodyEl.replaceChildren(...data.outlets.map(buildRow));
}

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    render(data);
    metaEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
    metaEl.style.color = '';
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

async function controlOutlet(n, action) {
  metaEl.textContent = `outlet ${n} → ${action}…`;
  try {
    const res = await fetch(`/api/outlet/${n}/${action}`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    setTimeout(fetchStatus, 600);
  } catch (err) {
    metaEl.textContent = `error: ${err.message}`;
    metaEl.style.color = '#ef4444';
  }
}

fetchStatus();
setInterval(fetchStatus, POLL_MS);

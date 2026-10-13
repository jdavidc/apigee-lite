'use strict';
/* Apigee Lite UI core: API client, DOM helpers, router. */

const ORG = 'practice';

async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  const res = await fetch(`/v1/organizations/${ORG}${path}`, opts);
  if (raw) return res;
  const text = await res.text();
  let data = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!res.ok) {
    const err = new Error((data && data.message) || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

function toast(msg, type = '') {
  const t = h('div', { class: `toast ${type}` }, msg);
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), type === 'err' ? 7000 : 3500);
}

function modal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => { bd.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const foot = h('div', { class: 'modal-foot' },
    h('button', { class: 'btn', onclick: close }, 'Cancel'),
    actions.map((a) => h('button', {
      class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
      onclick: async (e) => {
        e.target.disabled = true;
        try { if ((await a.onClick()) !== false) close(); } catch (err) { toast(err.message, 'err'); } finally { e.target.disabled = false; }
      },
    }, a.label)));
  const bd = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === bd) close(); } },
    h('div', { class: `modal ${wide ? 'wide' : ''}` }, h('div', { class: 'modal-head' }, title), h('div', { class: 'modal-body' }, body), foot));
  document.body.appendChild(bd);
  document.addEventListener('keydown', esc);
  const first = bd.querySelector('input, select, textarea');
  if (first) first.focus();
  return close;
}

function confirmDialog(title, message, label = 'Delete') {
  return new Promise((resolve) => {
    let done = false;
    modal({ title, body: h('p', {}, message), actions: [{ label, danger: true, onClick: () => { done = true; resolve(true); } }], onClose: () => { if (!done) resolve(false); } });
  });
}

const field = (label, input, hint) => h('div', {}, h('label', {}, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
const statusClass = (s) => `status s${String(s)[0]}`;
const fmtTime = (iso) => new Date(iso).toLocaleTimeString();

function copyable(text) {
  return h('code', { title: 'Click to copy', style: { cursor: 'copy' }, onclick: () => { navigator.clipboard && navigator.clipboard.writeText(text); toast('Copied'); } }, text);
}

const App = {
  routes: [],
  cleanup: null,
  info: { environments: ['test', 'prod'], gatewayPort: 9001 },
  env: (() => { try { return localStorage.getItem('apigee-lite-env') || 'test'; } catch { return 'test'; } })(),
  setEnv(e) { this.env = e; try { localStorage.setItem('apigee-lite-env', e); } catch { /* ignore */ } },
  route(pattern, handler) { this.routes.push({ re: new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), handler }); },
  gatewayBase(env = 'test') { return `http://${env === 'prod' ? 'prod.' : ''}localhost:${this.info.gatewayPort}`; },
  envSelect(onChange, value = this.env) {
    return h('select', { onchange: (e) => { this.setEnv(e.target.value); onChange(e.target.value); } }, this.info.environments.map((e) => h('option', { value: e, selected: e === value }, e)));
  },
  async start() {
    try {
      this.info = await api('GET', '');
      document.getElementById('org-name').textContent = this.info.name;
      document.getElementById('gw-url').textContent = this.gatewayBase('test');
    } catch (e) { toast('Cannot reach management API: ' + e.message, 'err'); }
    window.addEventListener('hashchange', () => this.render());
    this.render();
  },
  async render() {
    if (this.cleanup) { try { this.cleanup(); } catch { /* ignore */ } this.cleanup = null; }
    const hash = location.hash.replace(/^#/, '') || '/proxies';
    const top = hash.split('/')[1];
    document.querySelectorAll('#sidenav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === top));
    const view = document.getElementById('view');
    for (const r of this.routes) {
      const m = r.re.exec(hash);
      if (m) {
        view.innerHTML = '';
        try { await r.handler(view, ...m.slice(1).map(decodeURIComponent)); } catch (e) { view.appendChild(h('div', { class: 'card' }, h('b', {}, 'Error: '), e.message)); }
        return;
      }
    }
    view.innerHTML = '';
    view.appendChild(h('div', { class: 'empty' }, 'Page not found'));
  },
};

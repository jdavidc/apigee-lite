'use strict';
/* Org entities: API products, developers, apps, KVMs, target servers, logs, analytics. */

const csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

function pageHead(title, subtitle, ...actions) {
  return h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), subtitle ? h('div', { class: 'muted' }, subtitle) : null), h('div', { class: 'btn-row' }, actions));
}

// ---------- API products ----------
async function productForm(existing) {
  const proxies = await api('GET', '/apis');
  const p = existing || { proxies: [], environments: ['test'], scopes: [], apiResources: [] };
  const name = h('input', { type: 'text', value: p.name || '', disabled: !!existing });
  const display = h('input', { type: 'text', value: p.displayName || '' });
  const desc = h('input', { type: 'text', value: p.description || '' });
  const scopes = h('input', { type: 'text', value: (p.scopes || []).join(', '), placeholder: 'read, write' });
  const resources = h('input', { type: 'text', value: (p.apiResources || []).join(', '), placeholder: '/, /**, /orders/*' });
  const quota = h('input', { type: 'number', value: p.quota || '', placeholder: 'e.g. 100' });
  const interval = h('input', { type: 'number', value: p.quotaInterval || '1' });
  const unit = h('select', {}, ['minute', 'hour', 'day', 'month'].map((u) => h('option', { selected: p.quotaTimeUnit === u }, u)));
  const checks = (items, chosen) => h('div', { class: 'checks' }, items.map((i) => h('label', {}, h('input', { type: 'checkbox', value: i, checked: chosen.includes(i) }), i)));
  const proxyChecks = checks(proxies, p.proxies || []);
  const envChecks = checks(App.info.environments, p.environments || []);
  const picked = (el) => [...el.querySelectorAll('input:checked')].map((i) => i.value);
  modal({
    title: existing ? `Edit API product ${p.name}` : 'New API product',
    body: h('div', { class: 'form' },
      field('Name', name), field('Display name', display), field('Description', desc),
      field('Environments', envChecks), field('API proxies', proxyChecks, 'Keys/tokens for this product are only valid for these proxies (empty = all).'),
      field('Resource paths', resources, 'Optional proxy.pathsuffix patterns, comma separated (empty = all).'),
      field('OAuth scopes', scopes, 'Comma separated'),
      h('label', {}, 'Quota (read by the Quota policy through verifyapikey.{policy}.apiproduct.developer.quota.*)'),
      h('div', { class: 'btn-row' }, quota, ' requests every ', interval, unit)),
    actions: [{
      label: 'Save', primary: true,
      onClick: async () => {
        const body = { name: name.value.trim(), displayName: display.value.trim() || name.value.trim(), description: desc.value, proxies: picked(proxyChecks), environments: picked(envChecks), scopes: csv(scopes.value), apiResources: csv(resources.value), quota: quota.value, quotaInterval: interval.value, quotaTimeUnit: unit.value };
        if (existing) await api('PUT', `/apiproducts/${encodeURIComponent(p.name)}`, body); else await api('POST', '/apiproducts', body);
        toast('API product saved', 'ok'); App.render();
      },
    }],
  });
}

App.route('/products', async (view) => {
  const list = await api('GET', '/apiproducts?expand=true');
  view.append(pageHead('API Products', 'Bundle proxies, environments, scopes and quota. Apps get keys for products.', h('button', { class: 'btn primary', onclick: () => productForm() }, '+ API Product')),
    h('table', { class: 'grid' },
      h('tr', {}, ['Name', 'Proxies', 'Environments', 'Scopes', 'Quota', ''].map((x) => h('th', {}, x))),
      list.map((p) => h('tr', {},
        h('td', {}, h('b', {}, p.name), h('div', { class: 'muted small' }, p.displayName)),
        h('td', {}, p.proxies.length ? p.proxies.map((x) => h('span', { class: 'pill' }, x)) : h('span', { class: 'muted' }, 'all')),
        h('td', {}, p.environments.map((x) => h('span', { class: 'pill' }, x))),
        h('td', {}, p.scopes.map((x) => h('span', { class: 'pill info' }, x))),
        h('td', {}, p.quota ? `${p.quota} / ${p.quotaInterval} ${p.quotaTimeUnit}` : h('span', { class: 'muted' }, 'none')),
        h('td', { style: { textAlign: 'right' } },
          h('button', { class: 'btn small', onclick: () => productForm(p) }, 'Edit'), ' ',
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('Delete API product', `Delete ${p.name}?`)) { await api('DELETE', `/apiproducts/${encodeURIComponent(p.name)}`).catch((e) => toast(e.message, 'err')); App.render(); } } }, 'Delete'))))));
});

// ---------- Developers ----------
App.route('/developers', async (view) => {
  const list = await api('GET', '/developers?expand=true');
  const add = () => {
    const email = h('input', { type: 'text' }); const fn = h('input', { type: 'text' }); const ln = h('input', { type: 'text' }); const un = h('input', { type: 'text' });
    modal({ title: 'New developer', body: h('div', { class: 'form' }, field('Email', email), field('First name', fn), field('Last name', ln), field('Username', un)),
      actions: [{ label: 'Create', primary: true, onClick: async () => { await api('POST', '/developers', { email: email.value.trim(), firstName: fn.value, lastName: ln.value, userName: un.value }); App.render(); } }] });
  };
  view.append(pageHead('Developers', 'Developers own apps.', h('button', { class: 'btn primary', onclick: add }, '+ Developer')),
    h('table', { class: 'grid' }, h('tr', {}, ['Email', 'Name', 'Apps', 'Status', ''].map((x) => h('th', {}, x))),
      list.map((d) => h('tr', {}, h('td', {}, h('b', {}, d.email)), h('td', {}, `${d.firstName} ${d.lastName}`), h('td', {}, d.apps.map((a) => h('span', { class: 'pill' }, a))),
        h('td', {}, h('span', { class: `pill ${d.status === 'active' ? 'ok' : 'err'}` }, d.status)),
        h('td', { style: { textAlign: 'right' } },
          h('button', { class: 'btn small', onclick: async () => { await api('PUT', `/developers/${encodeURIComponent(d.email)}`, { status: d.status === 'active' ? 'inactive' : 'active' }); App.render(); } }, d.status === 'active' ? 'Deactivate' : 'Activate'), ' ',
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('Delete developer', `Delete ${d.email} and all apps?`)) { await api('DELETE', `/developers/${encodeURIComponent(d.email)}`); App.render(); } } }, 'Delete'))))));
});

// ---------- Apps ----------
App.route('/apps', async (view) => {
  const [apps, devs, prods] = await Promise.all([api('GET', '/apps'), api('GET', '/developers'), api('GET', '/apiproducts')]);
  const add = () => {
    const dev = h('select', {}, devs.map((d) => h('option', {}, d)));
    const name = h('input', { type: 'text' });
    const key = h('input', { type: 'text', placeholder: 'leave empty to generate' });
    const secret = h('input', { type: 'text', placeholder: 'leave empty to generate' });
    const checks = h('div', { class: 'checks' }, prods.map((p) => h('label', {}, h('input', { type: 'checkbox', value: p }), p)));
    modal({ title: 'New developer app', body: h('div', { class: 'form' }, field('Developer', dev), field('App name', name), field('API products', checks), field('Consumer key (optional)', key), field('Consumer secret (optional)', secret)),
      actions: [{ label: 'Create', primary: true, onClick: async () => {
        const body = { name: name.value.trim(), apiProducts: [...checks.querySelectorAll('input:checked')].map((i) => i.value) };
        if (key.value.trim()) body.consumerKey = key.value.trim();
        if (secret.value.trim()) body.consumerSecret = secret.value.trim();
        await api('POST', `/developers/${encodeURIComponent(dev.value)}/apps`, body); App.render();
      } }] });
  };
  const editProducts = (a) => {
    const cur = a.credentials[0].apiProducts.map((p) => p.apiproduct);
    const checks = h('div', { class: 'checks' }, prods.map((p) => h('label', {}, h('input', { type: 'checkbox', value: p, checked: cur.includes(p) }), p)));
    modal({ title: `Products for ${a.name}`, body: h('div', { class: 'form' }, field('API products', checks)),
      actions: [{ label: 'Save', primary: true, onClick: async () => { await api('PUT', `/developers/${encodeURIComponent(a.developerEmail)}/apps/${encodeURIComponent(a.name)}`, { apiProducts: [...checks.querySelectorAll('input:checked')].map((i) => i.value) }); App.render(); } }] });
  };
  view.append(pageHead('Apps', 'Each app has a consumer key (API key / client_id) and secret.', h('button', { class: 'btn primary', onclick: add }, '+ App')),
    h('table', { class: 'grid' }, h('tr', {}, ['App', 'Credentials', 'Products', 'Status', ''].map((x) => h('th', {}, x))),
      apps.map((a) => {
        const c = a.credentials[0];
        const secret = h('span', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); secret.replaceChildren(copyable(c.consumerSecret)); } }, 'show secret'));
        return h('tr', {},
          h('td', {}, h('b', {}, a.name), h('div', { class: 'muted small' }, a.developerEmail)),
          h('td', {}, h('div', {}, 'Key: ', copyable(c.consumerKey), ' ', h('span', { class: `pill ${c.status === 'approved' ? 'ok' : 'err'}` }, c.status)), h('div', {}, 'Secret: ', secret)),
          h('td', {}, c.apiProducts.map((p) => h('span', { class: 'pill' }, p.apiproduct))),
          h('td', {}, h('span', { class: `pill ${a.status === 'approved' ? 'ok' : 'err'}` }, a.status)),
          h('td', { style: { textAlign: 'right' } },
            h('button', { class: 'btn small', onclick: () => editProducts(a) }, 'Products'), ' ',
            h('button', { class: 'btn small', onclick: async () => { await api('POST', `/developers/${encodeURIComponent(a.developerEmail)}/apps/${encodeURIComponent(a.name)}/keys/${encodeURIComponent(c.consumerKey)}?action=${c.status === 'approved' ? 'revoke' : 'approve'}`); App.render(); } }, c.status === 'approved' ? 'Revoke key' : 'Approve key'), ' ',
            h('button', { class: 'btn small', onclick: async () => { await api('POST', `/developers/${encodeURIComponent(a.developerEmail)}/apps/${encodeURIComponent(a.name)}?action=${a.status === 'approved' ? 'revoke' : 'approve'}`); App.render(); } }, a.status === 'approved' ? 'Revoke app' : 'Approve app'), ' ',
            h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('Delete app', `Delete ${a.name}?`)) { await api('DELETE', `/developers/${encodeURIComponent(a.developerEmail)}/apps/${encodeURIComponent(a.name)}`); App.render(); } } }, 'Delete')));
      })));
});

// ---------- KVMs ----------
App.route('/kvms', async (view) => {
  const proxies = await api('GET', '/apis');
  let scope = `env:${App.env}`;
  const sel = h('select', { onchange: (e) => { scope = e.target.value; if (scope.startsWith('env:')) App.setEnv(scope.slice(4)); load(); } },
    h('optgroup', { label: 'Environment scope' }, App.info.environments.map((e) => h('option', { value: `env:${e}`, selected: scope === `env:${e}` }, `environment: ${e}`))),
    h('optgroup', { label: 'API proxy scope' }, proxies.map((p) => h('option', { value: `api:${p}` }, `apiproxy: ${p}`))),
    h('option', { value: 'org' }, 'organization'));
  const box = h('div');
  const base = () => (scope === 'org' ? '/kvm-org' : scope.startsWith('env:') ? `/environments/${scope.slice(4)}` : `/apis/${encodeURIComponent(scope.slice(4))}`);
  async function load() {
    const maps = await api('GET', `${base()}/keyvaluemaps`);
    box.innerHTML = '';
    if (!maps.length) box.append(h('div', { class: 'card empty' }, 'No maps in this scope'));
    for (const m of maps) {
      const k = h('input', { type: 'text', placeholder: 'key' });
      const v = h('input', { type: 'text', placeholder: 'value' });
      box.append(h('div', { class: 'card' },
        h('div', { class: 'page-head', style: { marginBottom: '6px' } }, h('div', {}, h('b', {}, m.name), m.encrypted ? h('span', { class: 'pill warn', style: { marginLeft: '6px' } }, 'encrypted') : null),
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('Delete map', `Delete ${m.name}?`)) { await api('DELETE', `${base()}/keyvaluemaps/${encodeURIComponent(m.name)}`); load(); } } }, 'Delete map')),
        h('table', { class: 'grid' }, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Value'), h('th', {}, '')),
          m.entry.map((e) => h('tr', {}, h('td', {}, h('code', {}, e.name)), h('td', {}, h('code', {}, e.value)),
            h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn small danger', onclick: async () => { await api('DELETE', `${base()}/keyvaluemaps/${encodeURIComponent(m.name)}/entries/${encodeURIComponent(e.name)}`); load(); } }, 'Delete'))))),
        h('div', { class: 'btn-row', style: { marginTop: '8px' } }, k, v, h('button', { class: 'btn', onclick: async () => { try { await api('POST', `${base()}/keyvaluemaps/${encodeURIComponent(m.name)}/entries`, { name: k.value.trim(), value: v.value }); load(); } catch (e) { toast(e.message, 'err'); } } }, 'Add / update entry'))));
    }
  }
  const add = () => {
    const name = h('input', { type: 'text' });
    const enc = h('input', { type: 'checkbox' });
    modal({ title: 'New key value map', body: h('div', { class: 'form' }, field('Name (mapIdentifier)', name), h('label', {}, enc, ' Encrypted (values can only be read into private.* variables)')),
      actions: [{ label: 'Create', primary: true, onClick: async () => { await api('POST', `${base()}/keyvaluemaps`, { name: name.value.trim(), encrypted: enc.checked }); load(); } }] });
  };
  view.append(pageHead('Key Value Maps', 'Read and written at runtime with the KeyValueMapOperations policy.', sel, h('button', { class: 'btn primary', onclick: add }, '+ Key Value Map')), box);
  await load();
});

// ---------- Target servers ----------
App.route('/targetservers', async (view) => {
  let env = App.env;
  const box = h('div');
  const form = (ts) => {
    const name = h('input', { type: 'text', value: ts ? ts.name : '', disabled: !!ts });
    const host = h('input', { type: 'text', value: ts ? ts.host : 'localhost' });
    const port = h('input', { type: 'number', value: ts ? ts.port : 9002 });
    const enabled = h('input', { type: 'checkbox', checked: ts ? ts.isEnabled : true });
    modal({ title: ts ? `Edit ${ts.name}` : `New target server (${env})`, body: h('div', { class: 'form' }, field('Name', name), field('Host', host), field('Port', port), h('label', {}, enabled, ' Enabled')),
      actions: [{ label: 'Save', primary: true, onClick: async () => {
        const body = { name: name.value.trim(), host: host.value.trim(), port: Number(port.value), isEnabled: enabled.checked };
        if (ts) await api('PUT', `/environments/${env}/targetservers/${encodeURIComponent(ts.name)}`, body); else await api('POST', `/environments/${env}/targetservers`, body);
        load();
      } }] });
  };
  async function load() {
    const list = await api('GET', `/environments/${env}/targetservers`);
    box.innerHTML = '';
    box.append(h('table', { class: 'grid' }, h('tr', {}, ['Name', 'Host', 'Port', 'Enabled', ''].map((x) => h('th', {}, x))),
      list.map((t) => h('tr', {}, h('td', {}, h('b', {}, t.name)), h('td', {}, t.host), h('td', {}, t.port), h('td', {}, h('span', { class: `pill ${t.isEnabled ? 'ok' : 'err'}` }, t.isEnabled ? 'yes' : 'no')),
        h('td', { style: { textAlign: 'right' } }, h('button', { class: 'btn small', onclick: () => form(t) }, 'Edit'), ' ',
          h('button', { class: 'btn small danger', onclick: async () => { if (await confirmDialog('Delete target server', `Delete ${t.name}?`)) { await api('DELETE', `/environments/${env}/targetservers/${encodeURIComponent(t.name)}`); load(); } } }, 'Delete'))))));
  }
  view.append(pageHead('Target Servers', 'Referenced from <LoadBalancer><Server name="..."/></LoadBalancer> in a TargetEndpoint.', App.envSelect((e) => { env = e; load(); }, env), h('button', { class: 'btn primary', onclick: () => form() }, '+ Target Server')), box);
  await load();
});

// ---------- Logs ----------
App.route('/logs', async (view) => {
  const filter = h('input', { type: 'text', placeholder: 'Filter (proxy, text...)' });
  const src = h('select', {}, ['all', 'MessageLogging', 'access', 'deploy'].map((s) => h('option', {}, s)));
  const box = h('div');
  let entries = [];
  const draw = () => {
    const f = filter.value.toLowerCase();
    const shown = entries.filter((e) => (src.value === 'all' || e.source === src.value) && (!f || JSON.stringify(e).toLowerCase().includes(f)));
    box.innerHTML = '';
    box.append(h('table', { class: 'grid' }, h('tr', {}, ['Time', 'Source', 'Env', 'Proxy', 'Message'].map((x) => h('th', {}, x))),
      shown.length ? [...shown].reverse().slice(0, 300).map((e) => h('tr', {}, h('td', { class: 'small' }, fmtTime(e.ts)), h('td', {}, h('span', { class: `pill ${e.source === 'MessageLogging' ? 'info' : ''}` }, e.source)), h('td', {}, e.env || ''), h('td', {}, e.proxy || ''), h('td', {}, h('code', {}, e.message))))
        : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, 'No log entries'))));
  };
  const load = async () => { entries = await api('GET', '/logs'); draw(); };
  filter.addEventListener('input', draw); src.addEventListener('change', draw);
  view.append(pageHead('Logs', 'MessageLogging output, gateway access log and deployment events.', filter, src, h('button', { class: 'btn', onclick: async () => { await api('DELETE', '/logs'); load(); } }, 'Clear')), box);
  await load();
  const t = setInterval(() => load().catch(() => {}), 3000);
  App.cleanup = () => clearInterval(t);
});

// ---------- Analytics ----------
App.route('/analytics', async (view) => {
  const stats = await api('GET', '/stats');
  view.append(pageHead('Analytics (lite)', 'Counts since the server started.', h('button', { class: 'btn', onclick: () => App.render() }, 'Refresh')),
    h('table', { class: 'grid' }, h('tr', {}, ['Proxy', 'Env', 'Requests', 'Errors (4xx/5xx)', 'Error rate', 'Avg latency', 'Status codes'].map((x) => h('th', {}, x))),
      stats.length ? stats.map((s) => h('tr', {}, h('td', {}, h('b', {}, s.proxy)), h('td', {}, s.env), h('td', {}, s.requests), h('td', {}, s.errors),
        h('td', {}, `${s.requests ? Math.round((s.errors / s.requests) * 100) : 0}%`), h('td', {}, `${s.avgLatencyMs} ms`),
        h('td', {}, Object.entries(s.status).map(([c, n]) => h('span', { class: `pill ${c < 400 ? 'ok' : 'err'}` }, `${c}: ${n}`)))))
        : h('tr', {}, h('td', { colspan: 7, class: 'empty' }, 'No traffic yet'))));
});

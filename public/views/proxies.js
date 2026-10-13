'use strict';
/* API proxy and shared flow lists, New Proxy wizard, proxy page shell and Overview tab. */

const KIND_LABEL = { apis: 'API Proxies', sharedflows: 'Shared Flows' };
const KIND_ONE = { apis: 'API proxy', sharedflows: 'shared flow' };
const kindPath = (kind) => (kind === 'apis' ? 'proxies' : 'sharedflows');

async function renderBundleList(view, kind) {
  const list = await api('GET', `/${kind}?expand=true`);
  const table = h('table', { class: 'grid' },
    h('tr', {}, h('th', {}, 'Name'), kind === 'apis' ? h('th', {}, 'Base path') : null, h('th', {}, 'Revisions'), h('th', {}, 'Deployed'), h('th', {}, '')),
    list.length ? list.map((p) => h('tr', { class: 'clickable', onclick: () => { location.hash = `#/${kindPath(kind)}/${encodeURIComponent(p.name)}/develop`; } },
      h('td', {}, h('b', {}, p.name)),
      kind === 'apis' ? h('td', {}, h('code', {}, p.basePaths.join(', '))) : null,
      h('td', {}, p.revision.length, h('span', { class: 'muted' }, ` (latest ${p.latestRevisionId})`)),
      h('td', {}, p.deployments.length ? p.deployments.map((d) => h('span', { class: 'pill ok' }, `${d.environment} r${d.revision}`)) : h('span', { class: 'muted' }, 'not deployed')),
      h('td', { style: { textAlign: 'right' } }, h('a', { href: `#/${kindPath(kind)}/${encodeURIComponent(p.name)}/overview`, onclick: (e) => e.stopPropagation() }, 'Overview'))))
      : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, `No ${KIND_LABEL[kind].toLowerCase()} yet`)));
  const fileInput = h('input', { type: 'file', accept: '.zip', style: { display: 'none' }, onchange: (e) => importBundle(kind, e.target.files[0]) });
  view.append(
    h('div', { class: 'page-head' },
      h('div', {}, h('h1', {}, KIND_LABEL[kind]), h('div', { class: 'muted' }, kind === 'apis' ? 'Proxies are stored as Edge bundles (apiproxy/...). Saving and deploying works like Edge.' : 'Reusable flows called from proxies with the FlowCallout policy.')),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Import bundle (.zip)'), fileInput,
        h('button', { class: 'btn primary', onclick: () => (kind === 'apis' ? newProxyWizard() : newSharedFlow()) }, kind === 'apis' ? '+ Proxy' : '+ Shared Flow'))),
    table);
}

async function importBundle(kind, file) {
  if (!file) return;
  const suggested = file.name.replace(/(_rev\d+)?\.zip$/i, '');
  const name = prompt(`Name for the imported ${KIND_ONE[kind]}:`, suggested);
  if (!name) return;
  try {
    const r = await api('POST', `/${kind}?action=import&name=${encodeURIComponent(name)}`, await file.arrayBuffer(), { headers: { 'content-type': 'application/octet-stream' } });
    toast(`Imported ${name} revision ${r.revision}${r.errors.length ? ` with ${r.errors.length} error(s)` : ''}`, r.errors.length ? 'err' : 'ok');
    location.hash = `#/${kindPath(kind)}/${encodeURIComponent(name)}/develop`;
  } catch (e) { toast(e.message, 'err'); }
}

function newProxyWizard() {
  let type = 'mock';
  const name = h('input', { type: 'text', placeholder: 'e.g. customers-v1' });
  const base = h('input', { type: 'text', placeholder: '/customers/v1' });
  const desc = h('input', { type: 'text', placeholder: 'Optional description' });
  const url = h('input', { type: 'text', value: `http://localhost:9002/echo` });
  const mockPath = h('input', { type: 'text', value: '', placeholder: 'e.g. /echo (empty = pass the path suffix through)' });
  name.addEventListener('input', () => { if (!base.dataset.touched) base.value = '/' + name.value.trim(); });
  base.addEventListener('input', () => { base.dataset.touched = '1'; });
  const urlRow = field('Existing API (target URL)', url, 'The proxy path suffix is appended to this URL, like in Edge.');
  const mockRow = field('Mock backend path (TargetServer "mock-backend")', mockPath, 'Mock endpoints: /orders, /orders/{id}, /echo, /status/{code}, /xml, /json, ?delay=ms');
  const opts = [
    ['mock', 'Mock backend', 'Reverse proxy to the built-in mock using a TargetServer + LoadBalancer'],
    ['url', 'Reverse proxy', 'Proxy an existing HTTP API by URL'],
    ['none', 'No target', 'Null RouteRule: build the response with policies'],
  ];
  const sync = () => {
    optsEl.querySelectorAll('.opt').forEach((o) => o.classList.toggle('active', o.dataset.t === type));
    urlRow.style.display = type === 'url' ? '' : 'none';
    mockRow.style.display = type === 'mock' ? '' : 'none';
  };
  const optsEl = h('div', { class: 'wizard-steps' }, opts.map(([t, title, d]) => h('div', { class: 'opt', 'data-t': t, onclick: () => { type = t; sync(); } }, h('b', {}, title), h('span', { class: 'muted small' }, d))));
  sync();
  modal({
    title: 'New API proxy',
    body: h('div', { class: 'form' }, h('label', {}, 'Proxy type'), optsEl, field('Proxy name', name), field('Base path', base, 'Requests to the gateway at this base path reach the proxy.'), field('Description', desc), urlRow, mockRow),
    actions: [{
      label: 'Create', primary: true,
      onClick: async () => {
        const n = name.value.trim();
        await api('POST', '/apis', { name: n, basePath: base.value.trim() || '/' + n, description: desc.value, targetType: type, targetUrl: url.value.trim(), targetPath: mockPath.value.trim() });
        toast(`Created ${n} revision 1`, 'ok');
        location.hash = `#/proxies/${encodeURIComponent(n)}/develop`;
      },
    }],
  });
}

function newSharedFlow() {
  const name = h('input', { type: 'text', placeholder: 'e.g. cors-handler' });
  modal({
    title: 'New shared flow',
    body: h('div', { class: 'form' }, field('Name', name)),
    actions: [{ label: 'Create', primary: true, onClick: async () => { const n = name.value.trim(); await api('POST', '/sharedflows', { name: n }); location.hash = `#/sharedflows/${encodeURIComponent(n)}/develop`; } }],
  });
}

async function renderBundlePage(view, kind, name, tab) {
  const info = await api('GET', `/${kind}/${encodeURIComponent(name)}`);
  const base = `#/${kindPath(kind)}/${encodeURIComponent(name)}`;
  const tabs = kind === 'apis' ? ['overview', 'develop', 'trace'] : ['overview', 'develop'];
  view.append(
    h('div', { class: 'breadcrumb' }, h('a', { href: `#/${kindPath(kind)}` }, KIND_LABEL[kind]), ' / ', name),
    h('div', { class: 'page-head' }, h('h1', {}, name),
      h('div', { class: 'btn-row' }, info.deployments.map((d) => h('span', { class: 'pill ok' }, `Deployed to ${d.environment}: r${d.revision}`)))),
    h('div', { class: 'tabs' }, tabs.map((t) => h('a', { href: `${base}/${t}`, class: t === tab ? 'active' : '' }, t[0].toUpperCase() + t.slice(1)))));
  const body = h('div');
  view.append(body);
  if (tab === 'overview') return renderOverview(body, kind, name, info);
  if (tab === 'develop') return Develop.render(body, kind, name, info);
  if (tab === 'trace') return Trace.render(body, name, info);
}

async function renderOverview(view, kind, name, info) {
  const envs = App.info.environments;
  const depOf = (env) => (info.deployments.find((d) => d.environment === env) || {}).revision;
  const deploy = async (env, rev) => {
    try {
      const r = await api('POST', `/environments/${env}/${kind}/${encodeURIComponent(name)}/revisions/${rev}/deployments`);
      toast(`Deployed revision ${rev} to ${env}${r.warnings && r.warnings.length ? `\nWarnings: ${r.warnings.map((w) => w.message).join('; ')}` : ''}`, 'ok');
      App.render();
    } catch (e) { toast(e.message, 'err'); }
  };
  const undeploy = async (env, rev) => {
    try { await api('DELETE', `/environments/${env}/${kind}/${encodeURIComponent(name)}/revisions/${rev}/deployments`); toast(`Undeployed from ${env}`, 'ok'); App.render(); } catch (e) { toast(e.message, 'err'); }
  };
  const revs = [...info.revision].reverse();
  view.append(...[
    kind === 'apis' ? h('div', { class: 'card' },
      h('h3', {}, 'Endpoints'),
      envs.map((env) => h('div', { class: 'kv' }, h('span', { class: 'muted' }, env), h('div', {}, info.basePaths.map((bp) => h('code', {}, App.gatewayBase(env) + bp)), depOf(env) ? '' : h('span', { class: 'muted' }, '  (not deployed)'))))) : null,
    h('h2', {}, 'Revisions and deployments'),
    h('table', { class: 'grid' },
      h('tr', {}, h('th', {}, 'Revision'), envs.map((e) => h('th', {}, e)), h('th', {}, '')),
      revs.map((rev) => h('tr', {},
        h('td', {}, h('b', {}, `Revision ${rev}`)),
        envs.map((env) => h('td', {}, depOf(env) === rev
          ? [h('span', { class: 'pill ok' }, 'deployed'), ' ', h('button', { class: 'btn small', onclick: () => undeploy(env, rev) }, 'Undeploy')]
          : h('button', { class: 'btn small', onclick: () => deploy(env, rev) }, `Deploy to ${env}`))),
        h('td', { style: { textAlign: 'right' } },
          h('a', { class: 'btn small', href: `/v1/organizations/${ORG}/${kind}/${encodeURIComponent(name)}/revisions/${rev}?format=bundle` }, 'Download zip'), ' ',
          h('button', {
            class: 'btn small danger', onclick: async () => {
              if (!(await confirmDialog('Delete revision', `Delete revision ${rev} of ${name}?`))) return;
              try { await api('DELETE', `/${kind}/${encodeURIComponent(name)}/revisions/${rev}`); App.render(); } catch (e) { toast(e.message, 'err'); }
            },
          }, 'Delete'))))),
    h('div', { class: 'btn-row', style: { marginTop: '16px' } },
      h('button', {
        class: 'btn danger', onclick: async () => {
          if (!(await confirmDialog(`Delete ${KIND_ONE[kind]}`, `Delete ${name} and all its revisions? Undeploy it first.`))) return;
          try { await api('DELETE', `/${kind}/${encodeURIComponent(name)}`); location.hash = `#/${kindPath(kind)}`; } catch (e) { toast(e.message, 'err'); }
        },
      }, `Delete ${KIND_ONE[kind]}`))].filter(Boolean));
}

App.route('/proxies', (v) => renderBundleList(v, 'apis'));
App.route('/sharedflows', (v) => renderBundleList(v, 'sharedflows'));
App.route('/proxies/:name', (v, n) => { location.replace(`#/proxies/${encodeURIComponent(n)}/develop`); });
App.route('/proxies/:name/:tab', (v, n, t) => renderBundlePage(v, 'apis', n, t));
App.route('/sharedflows/:name/:tab', (v, n, t) => renderBundlePage(v, 'sharedflows', n, t));

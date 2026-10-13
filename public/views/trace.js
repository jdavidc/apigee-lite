'use strict';
/* Trace tab: request composer, transaction list and per-step timeline. */

const Trace = {
  async render(view, name, info) {
    let env = App.env;
    let selected = null;
    let lastIds = '';
    const basePath = (info.basePaths && info.basePaths[0]) || '/';
    const verb = h('select', {}, ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'].map((v) => h('option', {}, v)));
    const path = h('input', { type: 'text', value: basePath, style: { flex: 1 } });
    const headers = h('textarea', { class: 'code', rows: 3, placeholder: 'x-api-key: practice-key-123\ncontent-type: application/json' });
    const body = h('textarea', { class: 'code', rows: 3, placeholder: 'Request body' });
    const respBox = h('div');
    const list = h('div', { class: 'tx-list' });
    const detail = h('div');
    const deployed = (e) => info.deployments.find((d) => d.environment === e);
    const envNote = h('span', { class: 'small muted' });
    const updateEnvNote = () => { const d = deployed(env); envNote.textContent = d ? `revision ${d.revision} deployed in ${env}` : `not deployed in ${env}`; envNote.style.color = d ? '' : 'var(--err)'; };
    updateEnvNote();

    const parseHeaders = () => {
      const out = {};
      for (const line of headers.value.split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      return out;
    };

    async function send() {
      try {
        const r = await api('POST', '/trace/send', { env, verb: verb.value, path: path.value, headers: parseHeaders(), body: body.value });
        respBox.innerHTML = '';
        respBox.append(h('div', { class: 'card', style: { marginTop: '10px' } },
          h('div', {}, h('span', { class: statusClass(r.status) }, r.status), h('span', { class: 'muted' }, `  ${r.durationMs} ms`)),
          h('details', {}, h('summary', { class: 'small muted' }, 'Response headers'), h('pre', { class: 'box' }, Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\n'))),
          codeBox('', r.body)));
        selected = null;
        await refresh(true);
      } catch (e) { toast(e.message, 'err'); }
    }

    async function refresh(selectLatest) {
      const txs = await api('GET', `/environments/${env}/apis/${encodeURIComponent(name)}/trace`);
      const ids = txs.map((t) => t.id).join(',');
      if (ids === lastIds && !selectLatest) return;
      lastIds = ids;
      list.innerHTML = '';
      if (!txs.length) list.append(h('div', { class: 'empty' }, 'No transactions yet. Send a request here or with curl.'));
      for (const t of [...txs].reverse()) {
        list.append(h('div', { class: `tx ${selected === t.id ? 'active' : ''}`, 'data-id': t.id, onclick: () => { selected = t.id; showTx(t.id); refreshActive(); } },
          h('span', { class: statusClass(t.status) }, t.status),
          h('span', { class: 'uri', title: t.uri }, `${t.verb} ${t.uri}`),
          h('span', { class: 'muted small' }, `${fmtTime(t.ts)} · ${t.durationMs}ms`)));
      }
      if ((selectLatest || !selected) && txs.length) { selected = txs[txs.length - 1].id; showTx(selected); refreshActive(); }
    }
    function refreshActive() {
      list.querySelectorAll('.tx').forEach((el) => el.classList.toggle('active', el.dataset.id === selected));
    }

    async function showTx(id) {
      let tx;
      try { tx = await api('GET', `/environments/${env}/apis/${encodeURIComponent(name)}/trace/${id}`); } catch (e) { detail.innerHTML = ''; return; }
      detail.innerHTML = '';
      const tl = h('div', { class: 'timeline' });
      tl.append(h('div', { class: 'tl-row section' }, `Request received · ${tx.request.verb} ${tx.request.uri}`));
      for (const s of tx.steps) tl.append(...Trace.row(s));
      tl.append(h('div', { class: 'tl-row section' }, `Response sent to client · ${tx.response.status} · ${tx.durationMs} ms`));
      detail.append(
        h('div', { class: 'page-head', style: { marginBottom: '8px' } },
          h('div', {}, h('b', {}, `${tx.request.verb} ${tx.request.uri}`), ' → ', h('span', { class: statusClass(tx.response.status) }, tx.response.status), tx.error ? h('span', { class: 'pill err', style: { marginLeft: '8px' } }, `fault: ${tx.error}`) : null),
          h('span', { class: 'muted small' }, `revision ${tx.revision} · ${new Date(tx.ts).toLocaleString()}`)),
        tl,
        h('details', { style: { marginTop: '10px' } }, h('summary', {}, 'Request (as received)'),
          codeBox(Object.entries(tx.request.headers).map(([k, v]) => `${k}: ${v}`).join('\n'), tx.request.content)),
        h('details', {}, h('summary', {}, 'Response (as sent)'),
          codeBox(Object.entries(tx.response.headers).map(([k, v]) => `${k}: ${v}`).join('\n'), tx.response.content)),
        h('details', {}, h('summary', {}, 'Flow variables at the end of the transaction'),
          h('table', { class: 'grid' }, Object.entries(tx.variables).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => h('tr', {}, h('td', {}, h('code', {}, k)), h('td', {}, h('code', {}, String(v))))))));
    }

    const envSel = App.envSelect((e) => { env = e; selected = null; lastIds = ''; updateEnvNote(); refresh(true); }, env);
    view.append(h('div', { class: 'trace' },
      h('div', {},
        h('div', { class: 'card' },
          h('div', { class: 'btn-row', style: { marginBottom: '8px' } }, h('b', {}, 'Send request'), envSel, envNote),
          h('div', { class: 'btn-row', style: { marginBottom: '6px' } }, verb, path),
          h('label', { class: 'small muted' }, 'Headers (one per line)'), headers,
          h('label', { class: 'small muted' }, 'Body'), body,
          h('div', { class: 'btn-row', style: { marginTop: '8px' } },
            h('button', { class: 'btn primary', onclick: send }, 'Send'),
            h('button', { class: 'btn', onclick: async () => { await api('DELETE', `/environments/${env}/apis/${encodeURIComponent(name)}/trace`); selected = null; lastIds = ''; detail.innerHTML = ''; refresh(true); } }, 'Clear transactions')),
          h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Trace is always on: requests sent with curl to ', h('code', {}, App.gatewayBase(env) + basePath), ' also appear below.'),
          respBox),
        h('h3', {}, 'Transactions'), list),
      h('div', {}, detail)));

    await refresh(true);
    const poll = setInterval(() => refresh(false).catch(() => {}), 2000);
    App.cleanup = () => clearInterval(poll);
  },

  row(s) {
    const icon = (cls, txt) => h('span', { class: `tl-icon ${cls}` }, txt);
    switch (s.kind) {
      case 'flow':
        return [h('div', { class: 'tl-row section' }, `${s.endpoint} · ${s.flow} · ${s.phase}`)];
      case 'condflow':
        return [h('div', { class: `tl-row ${s.conditionResult ? '' : 'skipped'}` }, icon(s.conditionResult ? 'info' : 'skip', s.conditionResult ? '→' : ''),
          h('div', {}, `Flow ${s.flow} `, h('span', { class: 'cond-code' }, s.condition || '(no condition)')), h('span', { class: `pill ${s.conditionResult ? 'info' : ''}` }, s.conditionResult ? 'matched' : 'false'))];
      case 'route':
        return [h('div', { class: `tl-row ${s.conditionResult ? '' : 'skipped'}` }, icon(s.conditionResult ? 'info' : 'skip', 'R'),
          h('div', {}, `RouteRule ${s.rule} → ${s.target || '(null route, no target)'} `, h('span', { class: 'cond-code' }, s.condition || '')), h('span', { class: `pill ${s.conditionResult ? 'info' : ''}` }, s.conditionResult ? 'selected' : 'false'))];
      case 'target':
        return [h('div', { class: `tl-row ${s.error ? 'error' : ''}` }, icon(s.error ? 'err' : 'warn', 'T'),
          h('div', {}, h('b', {}, 'Target request '), h('code', {}, `${s.method} ${s.url}`), s.error ? ` · ${s.error}` : ''),
          h('span', {}, s.status ? h('span', { class: statusClass(s.status) }, s.status) : '', h('span', { class: 'muted small' }, `  ${s.durationMs} ms`)))];
      case 'fault':
        return [h('div', { class: 'tl-row error' }, icon('err', '!'),
          h('div', {}, h('b', {}, `Error${s.inFaultRule ? ' in FaultRule' : ''}: ${s.name}`), ` · ${s.errorcode}${s.policy ? ` · raised by ${s.policy}` : ''}`, h('div', { class: 'small' }, s.faultstring)),
          h('span', { class: statusClass(s.status) }, s.status))];
      case 'faultrule':
        return [h('div', { class: `tl-row ${s.conditionResult ? '' : 'skipped'}` }, icon(s.conditionResult ? 'warn' : 'skip', 'F'),
          h('div', {}, `${s.isDefault ? 'DefaultFaultRule' : 'FaultRule'} ${s.rule} `, h('span', { class: 'cond-code' }, s.condition || (s.isDefault && s.alwaysEnforce ? 'AlwaysEnforce=true' : '(no condition)'))),
          h('span', { class: `pill ${s.conditionResult ? 'warn' : ''}` }, s.conditionResult ? 'executed' : 'false'))];
      case 'policy': {
        const state = s.error ? 'error' : s.executed ? 'executed' : 'skipped';
        const det = h('div', { class: 'tl-detail', style: { display: 'none' } },
          h('div', { class: 'kv' },
            h('span', { class: 'muted' }, 'Policy'), h('span', {}, `${s.policy} (${s.type})${s.sharedFlow ? ` in shared flow ${s.sharedFlow}` : ''}`),
            h('span', { class: 'muted' }, 'Condition'), h('span', {}, s.condition ? [h('code', {}, s.condition), ` → ${s.conditionResult}`] : '(none)'),
            h('span', { class: 'muted' }, 'Duration'), h('span', {}, s.durationMs !== undefined ? `${s.durationMs} ms` : '-'),
            s.skipped ? [h('span', { class: 'muted' }, 'Skipped'), h('span', {}, 'policy has enabled="false"')] : null),
          s.error ? h('div', { style: { marginTop: '6px' } }, h('b', { style: { color: 'var(--err)' } }, `Error: ${s.error.errorcode || ''}`), h('pre', { class: 'box' }, s.error.faultstring), s.error.continued ? h('div', { class: 'small' }, 'continueOnError="true": flow continued') : null) : null,
          s.prints && s.prints.length ? [h('b', {}, 'print() output'), h('pre', { class: 'box' }, s.prints.join('\n'))] : null,
          s.changes && s.changes.length ? [h('b', {}, `Variables changed (${s.changes.length})`), h('table', {}, s.changes.map((c) => h('tr', {}, h('td', {}, c.name), h('td', {}, c.from === null ? h('span', { class: 'muted' }, '(unset)') : String(c.from), ' → ', c.to === null ? h('span', { class: 'muted' }, '(removed)') : h('b', {}, String(c.to))))))]
            : s.executed ? h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'No variables changed') : null);
        const rowEl = h('div', { class: `tl-row clickable ${state === 'error' ? 'error' : state === 'skipped' ? 'skipped' : ''}`, onclick: () => { det.style.display = det.style.display === 'none' ? '' : 'none'; } },
          icon(state === 'error' ? 'err' : state === 'executed' ? 'ok' : 'skip', state === 'error' ? '✗' : state === 'executed' ? '✓' : ''),
          h('div', {}, h('b', {}, s.policy), h('span', { class: 'muted' }, ` ${s.type}`), s.sharedFlow ? h('span', { class: 'pill' }, s.sharedFlow) : null,
            s.condition ? h('div', { class: 'cond-code' }, `${s.condition} → ${s.conditionResult}`) : null),
          h('span', { class: 'muted small' }, state === 'skipped' ? (s.skipped ? 'disabled' : 'skipped') : `${s.durationMs} ms${s.changes && s.changes.length ? ` · ${s.changes.length} var(s)` : ''}`));
        return [rowEl, det];
      }
      default:
        return [h('div', { class: 'tl-row' }, icon('info', '·'), h('div', {}, JSON.stringify(s)), h('span'))];
    }
  },
};

function pretty(s) {
  if (!s) return '';
  try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
}

function bodyLang(s) {
  if (!s) return 'text';
  try { JSON.parse(s); return 'json'; } catch { /* not JSON */ }
  return /^\s*</.test(s) ? 'xml' : 'text';
}

function codeBox(headerText, bodyText) {
  const body = pretty(bodyText);
  const el = h('pre', { class: 'box' });
  el.innerHTML = (headerText ? `<span class="tok-decl">${Highlight.escape(headerText)}</span>` : '') +
    (headerText && body ? '\n\n' : '') + Highlight.highlight(body, bodyLang(body));
  return el;
}

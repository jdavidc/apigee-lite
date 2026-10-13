'use strict';
/* Develop tab: navigator, XML editor with validation, + Policy / + Step / + Flow / + Resource. */

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const XmlEdit = {
  indentAt(xml, idx) { const ls = xml.lastIndexOf('\n', idx - 1) + 1; return /^[ \t]*/.exec(xml.slice(ls))[0]; },

  stepXml(name, cond, ind) {
    return `${ind}<Step>\n${ind}    <Name>${escXml(name)}</Name>\n${cond ? `${ind}    <Condition>${escXml(cond)}</Condition>\n` : ''}${ind}</Step>`;
  },

  // Finds an element block: returns {start, openEnd, closeIdx, end, selfClosing} or null.
  block(xml, tag, nameAttr, from = 0, to = xml.length) {
    const re = new RegExp(`<${tag}\\b${nameAttr ? `[^>]*\\bname="${escRe(nameAttr)}"` : ''}[^>]*?(/?)>`, 'g');
    re.lastIndex = from;
    const m = re.exec(xml);
    if (!m || m.index >= to) return null;
    const openEnd = m.index + m[0].length;
    if (m[1] === '/') return { start: m.index, openEnd, closeIdx: openEnd, end: openEnd, selfClosing: true };
    const closeIdx = xml.indexOf(`</${tag}>`, openEnd);
    if (closeIdx < 0) return null;
    return { start: m.index, openEnd, closeIdx, end: closeIdx + tag.length + 3, selfClosing: false };
  },

  appendChildBlock(xml, b, tag, innerBuilder) {
    const ind = this.indentAt(xml, b.start);
    const inner = innerBuilder(ind + '    ');
    if (b.selfClosing) {
      const open = xml.slice(b.start, b.openEnd).replace(/\s*\/>$/, '>');
      return xml.slice(0, b.start) + `${open}\n${inner}\n${ind}</${tag}>` + xml.slice(b.end);
    }
    const before = xml.slice(0, b.closeIdx).replace(/[ \t]*$/, '').replace(/\n?$/, '\n');
    return before + inner + '\n' + ind + xml.slice(b.closeIdx);
  },

  // flow: {type: 'PreFlow'|'PostFlow'|'PostClientFlow'|'Flow'|'SharedFlow', name}, phase: 'Request'|'Response'
  insertStep(xml, flow, phase, stepName, cond) {
    if (flow.type === 'SharedFlow') {
      const b = this.block(xml, 'SharedFlow');
      if (!b) throw new Error('No <SharedFlow> element found');
      return this.appendChildBlock(xml, b, 'SharedFlow', (ind) => this.stepXml(stepName, cond, ind));
    }
    let fb = flow.type === 'Flow' ? this.block(xml, 'Flow', flow.name) : this.block(xml, flow.type);
    if (!fb) {
      const root = /<(ProxyEndpoint|TargetEndpoint)\b/.exec(xml);
      if (!root) throw new Error('No endpoint root element found');
      const rb = this.block(xml, root[1]);
      const nameAttr = flow.type === 'Flow' ? flow.name : flow.type;
      if (flow.type === 'Flow') {
        xml = this.insertFlow(xml, nameAttr, '');
      } else {
        xml = this.appendChildBlock(xml, rb, root[1], (ind) => `${ind}<${flow.type} name="${nameAttr}">\n${ind}    <Request/>\n${ind}    <Response/>\n${ind}</${flow.type}>`);
      }
      fb = flow.type === 'Flow' ? this.block(xml, 'Flow', flow.name) : this.block(xml, flow.type);
    }
    if (fb.selfClosing) {
      xml = this.appendChildBlock(xml, fb, flow.type, (ind) => `${ind}<Request/>\n${ind}<Response/>`);
      fb = flow.type === 'Flow' ? this.block(xml, 'Flow', flow.name) : this.block(xml, flow.type);
    }
    const pb = this.block(xml, phase, null, fb.openEnd, fb.closeIdx);
    if (!pb) {
      return this.appendChildBlock(xml, fb, flow.type, (ind) => `${ind}<${phase}>\n${this.stepXml(stepName, cond, ind + '    ')}\n${ind}</${phase}>`);
    }
    return this.appendChildBlock(xml, pb, phase, (ind) => this.stepXml(stepName, cond, ind));
  },

  insertFlow(xml, name, cond) {
    const flowXml = (ind) => `${ind}<Flow name="${escXml(name)}">\n${ind}    <Description/>\n${ind}    <Request/>\n${ind}    <Response/>\n${cond ? `${ind}    <Condition>${escXml(cond)}</Condition>\n` : ''}${ind}</Flow>`;
    const fb = this.block(xml, 'Flows');
    if (fb) return this.appendChildBlock(xml, fb, 'Flows', flowXml);
    const root = /<(ProxyEndpoint|TargetEndpoint)\b/.exec(xml);
    if (!root) throw new Error('No endpoint root element found');
    return this.appendChildBlock(xml, this.block(xml, root[1]), root[1], (ind) => `${ind}<Flows>\n${flowXml(ind + '    ')}\n${ind}</Flows>`);
  },
};

const Develop = {
  templates: null,

  async loadTemplates() {
    if (!this.templates) this.templates = await api('GET', '/policytemplates');
    return this.templates;
  },

  async render(view, kind, name, info) {
    const root = kind === 'apis' ? 'apiproxy' : 'sharedflowbundle';
    const st = { kind, name, root, rev: info.latestRevisionId, files: {}, model: null, errors: [], warnings: [], current: null, dirty: false, info, timer: null };
    const enc = encodeURIComponent(name);

    const revSel = h('select', { onchange: async (e) => { if (st.dirty && !window.confirm('Discard unsaved changes?')) { e.target.value = st.rev; return; } await load(e.target.value); } },
      [...info.revision].reverse().map((r) => h('option', { value: r }, `Revision ${r}`)));
    const dirtyMark = h('span', { class: 'dirty-dot' });
    const navEl = h('div', { class: 'navigator' });
    const pathEl = h('code', {});
    const gutter = h('div', { class: 'gutter' });
    const ta = h('textarea', { class: 'code', spellcheck: false, wrap: 'off' });
    const hlCode = h('code', {});
    const hl = h('pre', { class: 'highlight', 'aria-hidden': 'true' }, hlCode);
    const problems = h('div', { class: 'problems' });
    const delBtn = h('button', { class: 'btn small danger', onclick: () => deleteFile() }, 'Delete file');

    const toolbar = h('div', { class: 'toolbar' },
      revSel, dirtyMark,
      h('button', { class: 'btn primary', onclick: () => save(false) }, 'Save'),
      h('button', { class: 'btn', onclick: () => save(true) }, 'Save as New Revision'),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => addPolicy() }, '+ Policy'),
      h('button', { class: 'btn', onclick: () => addStep() }, '+ Step'),
      kind === 'apis' ? h('button', { class: 'btn', onclick: () => addFlow() }, '+ Flow') : null,
      h('button', { class: 'btn', onclick: () => addResource() }, '+ Resource'),
      h('button', { class: 'btn', onclick: () => deployCurrent('test') }, 'Deploy to test'));

    view.append(toolbar, h('div', { class: 'dev' }, navEl,
      h('div', { class: 'editor-wrap' },
        h('div', { class: 'editor-head' }, pathEl, delBtn),
        h('div', { class: 'editor' }, gutter, h('div', { class: 'code-area' }, hl, ta)),
        problems)));

    const setDirty = (d) => { st.dirty = d; dirtyMark.textContent = d ? '● unsaved' : ''; };

    function lineErrors() {
      return new Set(st.errors.filter((e) => e.file === st.current && e.line).map((e) => e.line));
    }
    function renderGutter() {
      const n = ta.value.split('\n').length;
      const errs = lineErrors();
      gutter.innerHTML = '';
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= n; i++) frag.appendChild(h('div', { class: errs.has(i) ? 'err' : '' }, i));
      gutter.appendChild(frag);
      gutter.scrollTop = ta.scrollTop;
      renderHighlight();
    }
    function renderHighlight() {
      hlCode.innerHTML = Highlight.highlight(ta.value, Highlight.langFor(st.current)) + '\n';
      syncScroll();
    }
    function syncScroll() {
      gutter.scrollTop = ta.scrollTop;
      hl.scrollTop = ta.scrollTop;
      hl.scrollLeft = ta.scrollLeft;
    }
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('input', () => {
      if (!st.current) return;
      st.files[st.current] = ta.value;
      setDirty(true);
      renderGutter();
      clearTimeout(st.timer);
      st.timer = setTimeout(validate, 500);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = ta.selectionStart;
        ta.setRangeText('    ', s, ta.selectionEnd, 'end');
        ta.dispatchEvent(new Event('input'));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(false); }
    });

    function open(path, jump) {
      if (st.files[path] === undefined) return;
      st.current = path;
      pathEl.textContent = path;
      ta.value = st.files[path];
      ta.readOnly = false;
      delBtn.style.display = /\/(policies|resources)\//.test(path) ? '' : 'none';
      renderGutter();
      renderNav();
      ta.scrollTop = 0;
      if (jump) jumpTo(jump);
    }
    function jumpTo(target) {
      let idx = -1;
      if (typeof target === 'number') {
        const lines = ta.value.split('\n');
        idx = lines.slice(0, target - 1).join('\n').length + (target > 1 ? 1 : 0);
      } else if (target instanceof RegExp) {
        const m = target.exec(ta.value); idx = m ? m.index : -1;
      } else idx = ta.value.indexOf(target);
      if (idx < 0) return;
      const line = ta.value.slice(0, idx).split('\n').length;
      ta.focus();
      ta.setSelectionRange(idx, idx);
      ta.scrollTop = Math.max(0, (line - 4) * 19);
    }

    function navItem(label, cls, path, jump, extra) {
      const active = st.current === path && !jump;
      return h('div', { class: `nav-item ${cls || ''} ${active ? 'active' : ''}`, title: label, onclick: () => open(path, jump) }, extra || null, h('span', {}, label));
    }
    function stepsOf(part) { return [...(part ? part.request || [] : []), ...(part ? part.response || [] : [])]; }
    function flowItems(file, ep, isProxy) {
      const items = [];
      const add = (label, jumpRe, part, cond) => {
        items.push(h('div', { class: 'nav-item l2', title: cond || label, onclick: () => open(file, jumpRe) }, h('span', {}, label), cond ? h('span', { class: 'cond' }, cond) : null));
        for (const s of stepsOf(part)) {
          const pfile = `${root}/policies/${s.name}.xml`;
          items.push(h('div', { class: 'nav-item l3', title: s.condition || '', onclick: () => (st.files[pfile] !== undefined ? open(pfile) : toast(`Policy ${s.name} not found`, 'err')) }, '↳ ', s.name, s.condition ? h('span', { class: 'cond' }, ` [${s.condition}]`) : null));
        }
      };
      add('PreFlow', /<PreFlow\b/, ep.preFlow);
      for (const f of ep.flows) add(f.name, new RegExp(`<Flow\\s+name="${escRe(f.name)}"`), f, f.condition);
      add('PostFlow', /<PostFlow\b/, ep.postFlow);
      if (isProxy && ep.postClientFlow && stepsOf(ep.postClientFlow).length) add('PostClientFlow', /<PostClientFlow\b/, ep.postClientFlow);
      if (ep.faultRules && ep.faultRules.length) {
        items.push(h('div', { class: 'nav-item l2', onclick: () => open(file, /<FaultRules>/) }, h('span', {}, 'FaultRules'), h('span', { class: 'cond' }, ep.faultRules.map((r) => r.name).join(', '))));
      }
      if (ep.defaultFaultRule) items.push(h('div', { class: 'nav-item l2', onclick: () => open(file, /<DefaultFaultRule\b/) }, h('span', {}, 'DefaultFaultRule')));
      return items;
    }
    function renderNav() {
      navEl.innerHTML = '';
      const paths = Object.keys(st.files).sort();
      const m = st.model;
      const group = (title, ...items) => navEl.append(h('div', { class: 'nav-group' }, h('span', {}, title)), ...items);
      const descriptor = paths.find((p) => p.split('/').length === 2 && p.endsWith('.xml'));
      if (descriptor) group('Bundle', navItem(descriptor.split('/')[1], '', descriptor));
      if (kind === 'apis') {
        const peFiles = paths.filter((p) => p.startsWith(`${root}/proxies/`));
        group('Proxy Endpoints', ...peFiles.flatMap((f) => {
          const ep = m && m.proxyEndpoints.find((e) => `${root}/proxies/${e.name}.xml` === f);
          return [navItem(f.split('/').pop().replace('.xml', ''), '', f, null, ep ? h('span', { class: 'type-badge' }, ep.basePath) : null), ...(ep ? flowItems(f, ep, true) : [])];
        }));
        const teFiles = paths.filter((p) => p.startsWith(`${root}/targets/`));
        group('Target Endpoints', ...(teFiles.length ? teFiles.flatMap((f) => {
          const ep = m && m.targetEndpoints.find((e) => `${root}/targets/${e.name}.xml` === f);
          return [navItem(f.split('/').pop().replace('.xml', ''), '', f), ...(ep ? flowItems(f, ep, false) : [])];
        }) : [h('div', { class: 'nav-item l2 muted' }, 'none (no-target proxy)')]));
      } else {
        group('Shared Flows', ...paths.filter((p) => p.startsWith(`${root}/sharedflows/`)).map((f) => navItem(f.split('/').pop().replace('.xml', ''), '', f)));
      }
      const pols = paths.filter((p) => p.startsWith(`${root}/policies/`));
      group(`Policies (${pols.length})`, ...pols.map((f) => {
        const pn = f.split('/').pop().replace('.xml', '');
        const pm = m && m.policies.find((x) => x.name === pn);
        return navItem(pn, '', f, null, pm ? h('span', { class: `type-badge ${pm.supported ? '' : 'bad'}`, title: pm.supported ? '' : 'Not supported in Apigee Lite' }, pm.type) : null);
      }));
      const res = paths.filter((p) => p.startsWith(`${root}/resources/`));
      group('Resources', ...(res.length ? res.map((f) => navItem(f.slice(`${root}/resources/`.length), '', f)) : [h('div', { class: 'nav-item l2 muted' }, 'none')]));
    }

    function renderProblems() {
      problems.innerHTML = '';
      if (!st.errors.length && !st.warnings.length) { problems.append(h('div', { class: 'okmsg' }, '✓ No problems. Bundle is valid.')); return; }
      for (const e of st.errors) problems.append(h('div', { class: 'e', onclick: () => open(e.file, e.line || null) }, `✗ ${e.file}${e.line ? `:${e.line}` : ''}  ${e.message}`));
      for (const w of st.warnings) problems.append(h('div', { class: 'w', onclick: () => open(w.file) }, `⚠ ${w.file}  ${w.message}`));
    }

    async function validate() {
      try {
        const r = await api('POST', `/${kind}/${enc}/validate`, { files: st.files });
        st.errors = r.errors; st.warnings = r.warnings;
        if (!r.errors.some((e) => /XML error/.test(e.message))) st.model = r.model;
        renderProblems(); renderGutter(); renderNav();
      } catch (e) { toast(e.message, 'err'); }
    }

    async function load(rev) {
      const r = await api('GET', `/${kind}/${enc}/revisions/${rev}/files`);
      st.rev = String(rev); revSel.value = st.rev;
      st.files = r.files; st.model = r.model; st.errors = r.errors; st.warnings = r.warnings;
      setDirty(false);
      const paths = Object.keys(st.files).sort();
      const first = (st.current && st.files[st.current] !== undefined && st.current)
        || paths.find((p) => p === `${root}/proxies/default.xml`) || paths.find((p) => p.includes('/proxies/') || p.includes('/sharedflows/')) || paths[0];
      open(first);
      renderProblems();
    }

    async function save(asNew) {
      try {
        if (asNew) {
          const r = await api('POST', `/${kind}/${enc}/revisions`, { files: st.files });
          toast(`Saved as revision ${r.revision}${r.errors.length ? ` (${r.errors.length} problem(s))` : ''}`, r.errors.length ? 'err' : 'ok');
          st.info = await api('GET', `/${kind}/${enc}`);
          revSel.innerHTML = '';
          [...st.info.revision].reverse().forEach((x) => revSel.append(h('option', { value: x }, `Revision ${x}`)));
          await load(r.revision);
          return;
        }
        const r = await api('PUT', `/${kind}/${enc}/revisions/${st.rev}/files`, { files: st.files });
        st.errors = r.errors; st.warnings = r.warnings;
        setDirty(false);
        renderProblems(); renderGutter();
        if (r.errors.length) toast(`Saved revision ${st.rev} with ${r.errors.length} problem(s); it cannot be deployed until fixed.`, 'err');
        else if (r.redeployError) toast(`Saved, but redeploy failed: ${r.redeployError}`, 'err');
        else toast(`Saved revision ${st.rev}${r.redeployed.length ? ` and redeployed to ${r.redeployed.map((d) => d.environment).join(', ')}` : ''}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }

    async function deployCurrent(env) {
      if (st.dirty) await save(false);
      try {
        await api('POST', `/environments/${env}/${kind}/${enc}/revisions/${st.rev}/deployments`);
        toast(`Revision ${st.rev} deployed to ${env}`, 'ok');
      } catch (e) { toast(e.message, 'err'); }
    }

    function flowTargets() {
      const out = [];
      const m = st.model;
      if (!m) return out;
      if (kind === 'sharedflows') { m.sharedFlows.forEach((s) => out.push({ label: `SharedFlow ${s.name}`, file: `${root}/sharedflows/${s.name}.xml`, flow: { type: 'SharedFlow' }, phase: null })); return out; }
      const eps = [...m.proxyEndpoints.map((e) => ['proxies', 'ProxyEndpoint', e]), ...m.targetEndpoints.map((e) => ['targets', 'TargetEndpoint', e])];
      for (const [dir, label, ep] of eps) {
        const file = `${root}/${dir}/${ep.name}.xml`;
        const flows = [{ type: 'PreFlow', name: 'PreFlow' }, ...ep.flows.map((f) => ({ type: 'Flow', name: f.name })), { type: 'PostFlow', name: 'PostFlow' }];
        for (const f of flows) for (const phase of ['Request', 'Response']) out.push({ label: `${label} ${ep.name} › ${f.name} › ${phase}`, file, flow: f, phase });
        if (dir === 'proxies') out.push({ label: `${label} ${ep.name} › PostClientFlow › Response`, file, flow: { type: 'PostClientFlow', name: 'PostClientFlow' }, phase: 'Response' });
      }
      return out;
    }

    function attach(target, policyName, cond) {
      st.files[target.file] = XmlEdit.insertStep(st.files[target.file], target.flow, target.phase, policyName, cond);
    }

    async function addPolicy() {
      const t = await Develop.loadTemplates();
      let type = null;
      const nameIn = h('input', { type: 'text' });
      const preview = h('pre', { class: 'preview' }, 'Select a policy type');
      const targets = flowTargets();
      const attachSel = h('select', {}, h('option', { value: '-1' }, 'Do not attach (create policy only)'), targets.map((x, i) => h('option', { value: i }, x.label)));
      const condIn = h('input', { type: 'text', placeholder: 'Optional step condition, e.g. request.verb = "POST"' });
      const usedNames = new Set(Object.keys(st.files).filter((p) => p.includes('/policies/')).map((p) => p.split('/').pop().replace('.xml', '')));
      const defaultName = (ty) => { const base = ty.replace(/([a-z])([A-Z])/g, '$1-$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2'); let i = 1; while (usedNames.has(`${base}-${i}`)) i++; return `${base}-${i}`; };
      const typesEl = h('div', { class: 'types' });
      const pick = (ty) => {
        type = ty;
        typesEl.querySelectorAll('.t').forEach((x) => x.classList.toggle('active', x.dataset.t === ty));
        nameIn.value = defaultName(ty);
        preview.textContent = (t.templates[ty] || '').replace(/NAME/g, nameIn.value);
      };
      nameIn.addEventListener('input', () => { if (type) preview.textContent = (t.templates[type] || '').replace(/NAME/g, nameIn.value); });
      for (const [cat, types] of Object.entries(t.categories)) {
        typesEl.append(h('div', { class: 'cat' }, cat), ...types.map((ty) => h('div', { class: 't', 'data-t': ty, onclick: () => pick(ty) }, ty)));
      }
      modal({
        title: 'Add policy', wide: true,
        body: h('div', { class: 'type-list' }, typesEl, h('div', { class: 'form' },
          field('Policy name', nameIn, 'The file is created as policies/<name>.xml with Edge\'s default template.'),
          field('Attach to flow', attachSel), field('Step condition', condIn), h('label', {}, 'Template preview'), preview)),
        actions: [{
          label: 'Add', primary: true,
          onClick: () => {
            if (!type) throw new Error('Choose a policy type');
            const pn = nameIn.value.trim();
            if (!/^[A-Za-z0-9_\-.]+$/.test(pn)) throw new Error('Policy names may contain letters, digits, - _ .');
            const file = `${root}/policies/${pn}.xml`;
            if (st.files[file] !== undefined) throw new Error(`Policy ${pn} already exists`);
            st.files[file] = t.templates[type].replace(/NAME/g, pn);
            if (type === 'Javascript') {
              const js = `${root}/resources/jsc/${pn}.js`;
              if (st.files[js] === undefined) st.files[js] = `// ${pn}\nvar verb = context.getVariable('request.verb');\nprint('request verb is ' + verb);\ncontext.setVariable('my.variable', 'value');\n`;
            }
            const idx = Number(attachSel.value);
            if (idx >= 0) attach(targets[idx], pn, condIn.value.trim());
            setDirty(true);
            open(file);
            validate();
          },
        }],
      });
    }

    function addStep() {
      const pols = st.model ? st.model.policies.map((p) => p.name) : [];
      if (!pols.length) return toast('Create a policy first (+ Policy)', 'err');
      const targets = flowTargets();
      const polSel = h('select', {}, pols.map((p) => h('option', { value: p }, p)));
      const tSel = h('select', {}, targets.map((x, i) => h('option', { value: i }, x.label)));
      const condIn = h('input', { type: 'text', placeholder: 'Optional, e.g. request.header.x-debug = "true"' });
      modal({
        title: 'Add step',
        body: h('div', { class: 'form' }, field('Policy', polSel), field('Flow', tSel), field('Condition', condIn)),
        actions: [{ label: 'Add', primary: true, onClick: () => { const x = targets[Number(tSel.value)]; attach(x, polSel.value, condIn.value.trim()); setDirty(true); open(x.file, `<Name>${polSel.value}</Name>`); validate(); } }],
      });
    }

    function addFlow() {
      const m = st.model;
      if (!m) return toast('Fix XML errors first', 'err');
      const eps = [...m.proxyEndpoints.map((e) => [`${root}/proxies/${e.name}.xml`, `ProxyEndpoint ${e.name}`]), ...m.targetEndpoints.map((e) => [`${root}/targets/${e.name}.xml`, `TargetEndpoint ${e.name}`])];
      const epSel = h('select', {}, eps.map(([f, l]) => h('option', { value: f }, l)));
      const nameIn = h('input', { type: 'text', placeholder: 'e.g. getCustomer' });
      const pathIn = h('input', { type: 'text', placeholder: '/customers/*' });
      const verbSel = h('select', {}, ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map((v) => h('option', { value: v }, v || '(any verb)')));
      const condIn = h('input', { type: 'text' });
      const build = () => {
        const parts = [];
        if (pathIn.value.trim()) parts.push(`(proxy.pathsuffix MatchesPath "${pathIn.value.trim()}")`);
        if (verbSel.value) parts.push(`(request.verb = "${verbSel.value}")`);
        condIn.value = parts.join(' and ');
      };
      pathIn.addEventListener('input', build); verbSel.addEventListener('change', build);
      modal({
        title: 'Add conditional flow',
        body: h('div', { class: 'form' }, field('Endpoint', epSel), field('Flow name', nameIn), field('Path pattern', pathIn, '* matches one path segment, ** matches many'), field('Verb', verbSel), field('Condition', condIn, 'Generated from path and verb; edit freely. Empty = always matches.')),
        actions: [{
          label: 'Add', primary: true,
          onClick: () => {
            const n = nameIn.value.trim();
            if (!n) throw new Error('Flow name is required');
            st.files[epSel.value] = XmlEdit.insertFlow(st.files[epSel.value], n, condIn.value.trim());
            setDirty(true); open(epSel.value, `<Flow name="${n}"`); validate();
          },
        }],
      });
    }

    function addResource() {
      const nameIn = h('input', { type: 'text', placeholder: 'my-script.js' });
      modal({
        title: 'Add resource (jsc)',
        body: h('div', { class: 'form' }, field('File name', nameIn, 'Created under resources/jsc/ and referenced as jsc://<name> from a Javascript policy.')),
        actions: [{ label: 'Add', primary: true, onClick: () => {
          const n = nameIn.value.trim();
          if (!/^[\w\-.]+$/.test(n)) throw new Error('Invalid file name');
          const f = `${root}/resources/jsc/${n}`;
          if (st.files[f] !== undefined) throw new Error('File exists');
          st.files[f] = '// ' + n + '\n';
          setDirty(true); open(f); validate();
        } }],
      });
    }

    async function deleteFile() {
      const p = st.current;
      const pn = p.split('/').pop().replace('.xml', '');
      const refs = p.includes('/policies/') && Object.entries(st.files).some(([f, c]) => f !== p && c.includes(`<Name>${pn}</Name>`));
      if (!(await confirmDialog('Delete file', `Delete ${p}?${refs ? ' It is still referenced by a <Step>; remove the step too.' : ''}`))) return;
      delete st.files[p];
      st.current = null;
      setDirty(true);
      open(Object.keys(st.files).sort().find((x) => x.includes('/proxies/') || x.includes('/sharedflows/')));
      validate();
    }

    App.cleanup = () => { clearTimeout(st.timer); };
    window.onbeforeunload = () => (st.dirty ? true : undefined);
    await load(st.rev);
  },
};

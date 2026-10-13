'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const { HttpError, KINDS } = require('../store/org-store');
const { loadBundle, normalizeBasePath } = require('../runtime/bundle-loader');
const { validateXml } = require('../runtime/xml');
const policies = require('../runtime/policies');
const { newProxyFiles, newSharedFlowFiles } = require('./templates');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'public', 'policy-templates');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function validateFiles(files, kind) {
  const errors = [];
  for (const [p, c] of Object.entries(files)) {
    if (!p.endsWith('.xml')) continue;
    const e = validateXml(c);
    if (e) errors.push({ file: p, line: e.line, col: e.col, message: e.message });
  }
  const bundle = loadBundle(files, KINDS[kind]);
  for (const e of bundle.errors) if (!errors.some((x) => x.file === e.file && x.line && e.line === x.line)) errors.push(e);
  return { errors, warnings: bundle.warnings, bundle };
}

function filesFromZip(buf, kind) {
  const root = KINDS[kind];
  const zip = new AdmZip(buf);
  const files = {};
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    const i = name.indexOf(root + '/');
    if (i < 0) continue;
    files[name.slice(i)] = e.getData().toString('utf8');
  }
  if (!Object.keys(files).length) throw new HttpError(400, `Zip does not contain a ${root}/ folder`);
  return files;
}

function maskKvm(kvm) {
  return kvm.encrypted ? { ...kvm, entry: kvm.entry.map((e) => ({ name: e.name, value: '*****' })) } : kvm;
}

function createManagementRouter({ store, runtime, gatewayPort }) {
  const r = express.Router();
  const json = express.json({ limit: '10mb' });

  r.get('/', (req, res) => res.json({ name: store.orgName, environments: store.org.environments, gatewayPort: gatewayPort() }));
  r.get('/environments', (req, res) => res.json(store.org.environments));

  // ---------- API proxies and shared flows ----------
  for (const kind of ['apis', 'sharedflows']) {
    const label = kind === 'apis' ? 'API proxy' : 'Shared flow';
    const describe = (name) => {
      const revisions = store.listRevisions(kind, name);
      if (!revisions.length) throw new HttpError(404, `${label} ${name} not found`);
      const latest = revisions[revisions.length - 1];
      let basePaths = [];
      if (kind === 'apis') {
        try { basePaths = Object.values(loadBundle(store.readBundle(kind, name, latest), KINDS[kind]).proxyEndpoints).map((p) => p.basePath); } catch { basePaths = []; }
      }
      return { name, revision: revisions, latestRevisionId: latest, deployments: store.deploymentsOf(kind, name), basePaths };
    };

    r.get(`/${kind}`, (req, res) => {
      const names = store.listBundles(kind);
      res.json(req.query.expand === 'true' ? names.map(describe) : names);
    });

    r.post(`/${kind}`, express.raw({ type: () => true, limit: '20mb' }), wrap(async (req, res) => {
      if (req.query.action === 'import') {
        const name = req.query.name;
        if (!name) throw new HttpError(400, 'name query parameter is required');
        const files = filesFromZip(req.body, kind);
        const rev = store.createRevision(kind, name, files);
        const { errors, warnings } = validateFiles(store.readBundle(kind, name, rev), kind);
        res.status(201).json({ name, revision: rev, errors, warnings });
        return;
      }
      let body;
      try { body = JSON.parse(req.body.toString('utf8') || '{}'); } catch { throw new HttpError(400, 'Invalid JSON body'); }
      const name = String(body.name || '').trim();
      if (!name) throw new HttpError(400, 'name is required');
      if (store.listRevisions(kind, name).length) throw new HttpError(409, `${label} ${name} already exists`);
      let files;
      if (kind === 'apis') {
        const targetType = body.targetType || 'none';
        if (targetType === 'url' && !/^https?:\/\//.test(body.targetUrl || '')) throw new HttpError(400, 'targetUrl must be an http(s) URL');
        files = newProxyFiles({ name, basePath: normalizeBasePath(body.basePath || `/${name}`), targetType, targetUrl: body.targetUrl, targetPath: body.targetPath, description: body.description });
      } else files = newSharedFlowFiles({ name, description: body.description });
      const rev = store.createRevision(kind, name, files);
      res.status(201).json({ name, revision: rev });
    }));

    r.get(`/${kind}/:name`, (req, res) => res.json(describe(req.params.name)));
    r.delete(`/${kind}/:name`, (req, res) => { describe(req.params.name); store.deleteBundle(kind, req.params.name); res.json({ name: req.params.name, deleted: true }); });
    r.get(`/${kind}/:name/revisions`, (req, res) => res.json(describe(req.params.name).revision));
    r.get(`/${kind}/:name/deployments`, (req, res) => res.json(store.deploymentsOf(kind, req.params.name)));

    r.get(`/${kind}/:name/revisions/:rev`, (req, res) => {
      const { name, rev } = req.params;
      const files = store.readBundle(kind, name, rev);
      if (req.query.format === 'bundle') {
        const zip = new AdmZip();
        for (const [p, c] of Object.entries(files)) zip.addFile(p, Buffer.from(c, 'utf8'));
        res.setHeader('content-type', 'application/zip');
        res.setHeader('content-disposition', `attachment; filename="${name}_rev${rev}.zip"`);
        res.end(zip.toBuffer());
        return;
      }
      const b = loadBundle(files, KINDS[kind]);
      res.json({
        name, revision: rev, description: b.description,
        proxies: Object.keys(b.proxyEndpoints), targets: Object.keys(b.targetEndpoints), policies: Object.keys(b.policies),
        resources: Object.keys(b.resources), sharedFlows: Object.keys(b.sharedFlows),
      });
    });
    r.delete(`/${kind}/:name/revisions/:rev`, (req, res) => { store.deleteRevision(kind, req.params.name, req.params.rev); res.json({ deleted: true }); });

    r.get(`/${kind}/:name/revisions/:rev/files`, (req, res) => {
      const files = store.readBundle(kind, req.params.name, req.params.rev);
      const { errors, warnings, bundle } = validateFiles(files, kind);
      res.json({ name: req.params.name, revision: req.params.rev, files, errors, warnings, model: modelOf(bundle) });
    });

    r.put(`/${kind}/:name/revisions/:rev/files`, json, (req, res) => {
      const { name, rev } = req.params;
      store.readBundle(kind, name, rev);
      const files = req.body.files || {};
      store.writeBundle(kind, name, rev, files);
      const { errors, warnings } = validateFiles(files, kind);
      let redeployed = [];
      let redeployError = null;
      if (!errors.length) {
        try { redeployed = runtime.refresh(kind, name, rev); } catch (e) { redeployError = e.message; }
      }
      res.json({ name, revision: rev, errors, warnings, redeployed, redeployError });
    });

    r.post(`/${kind}/:name/revisions`, json, (req, res) => {
      const { name } = req.params;
      const revs = describe(name).revision;
      const files = req.body.files || store.readBundle(kind, name, req.body.fromRevision || revs[revs.length - 1]);
      const rev = store.createRevision(kind, name, files);
      const { errors, warnings } = validateFiles(store.readBundle(kind, name, rev), kind);
      res.status(201).json({ name, revision: rev, errors, warnings });
    });

    r.post(`/${kind}/:name/validate`, json, (req, res) => {
      const { errors, warnings, bundle } = validateFiles(req.body.files || {}, kind);
      res.json({ errors, warnings, model: modelOf(bundle) });
    });

    r.post(`/environments/:env/${kind}/:name/revisions/:rev/deployments`, (req, res) => {
      const { env, name, rev } = req.params;
      res.json(runtime.deploy(env, kind, name, rev));
    });
    r.delete(`/environments/:env/${kind}/:name/revisions/:rev/deployments`, (req, res) => {
      const { env, name, rev } = req.params;
      const cur = store.getDeployments(env)[kind][name];
      if (cur !== String(rev)) throw new HttpError(404, `Revision ${rev} of ${name} is not deployed to ${env}`);
      runtime.undeploy(env, kind, name);
      res.json({ environment: env, name, revision: rev, state: 'undeployed' });
    });
  }

  r.get('/environments/:env/deployments', (req, res) => res.json(store.getDeployments(req.params.env)));

  // ---------- API products ----------
  r.get('/apiproducts', (req, res) => res.json(req.query.expand === 'true' ? store.listProducts() : store.listProducts().map((p) => p.name)));
  r.post('/apiproducts', json, (req, res) => res.status(201).json(store.createProduct(req.body)));
  r.get('/apiproducts/:name', (req, res) => {
    const p = store.getProduct(req.params.name);
    if (!p) throw new HttpError(404, `API Product ${req.params.name} not found`);
    res.json(p);
  });
  r.put('/apiproducts/:name', json, (req, res) => res.json(store.updateProduct(req.params.name, req.body)));
  r.delete('/apiproducts/:name', (req, res) => { store.deleteProduct(req.params.name); res.json({ deleted: true }); });

  // ---------- Developers and apps ----------
  r.get('/developers', (req, res) => res.json(req.query.expand === 'true' ? store.listDevelopers() : store.listDevelopers().map((d) => d.email)));
  r.post('/developers', json, (req, res) => res.status(201).json(store.createDeveloper(req.body)));
  r.get('/developers/:email', (req, res) => res.json(store.getDeveloper(req.params.email)));
  r.put('/developers/:email', json, (req, res) => res.json(store.updateDeveloper(req.params.email, req.body)));
  r.delete('/developers/:email', (req, res) => { store.deleteDeveloper(req.params.email); res.json({ deleted: true }); });
  r.get('/apps', (req, res) => res.json(store.listApps()));
  r.get('/developers/:email/apps', (req, res) => res.json(store.listApps(req.params.email)));
  r.post('/developers/:email/apps', json, (req, res) => res.status(201).json(store.createApp(req.params.email, req.body)));
  r.get('/developers/:email/apps/:app', (req, res) => res.json(store.getApp(req.params.email, req.params.app)));
  r.put('/developers/:email/apps/:app', json, (req, res) => res.json(store.updateApp(req.params.email, req.params.app, req.body)));
  r.post('/developers/:email/apps/:app', (req, res) => {
    const action = req.query.action;
    if (action !== 'approve' && action !== 'revoke') throw new HttpError(400, 'action must be approve or revoke');
    res.json(store.setAppStatus(req.params.email, req.params.app, action));
  });
  r.post('/developers/:email/apps/:app/keys/:key', (req, res) => {
    const action = req.query.action;
    if (action !== 'approve' && action !== 'revoke') throw new HttpError(400, 'action must be approve or revoke');
    res.json(store.setKeyStatus(req.params.email, req.params.app, req.params.key, action));
  });
  r.delete('/developers/:email/apps/:app', (req, res) => { store.deleteApp(req.params.email, req.params.app); res.json({ deleted: true }); });

  // ---------- KVMs ----------
  const kvmRoutes = (prefix, scopeOf) => {
    r.get(`${prefix}/keyvaluemaps`, (req, res) => { const [s, o] = scopeOf(req); res.json(store.listKvms(s, o).map(maskKvm)); });
    r.post(`${prefix}/keyvaluemaps`, json, (req, res) => { const [s, o] = scopeOf(req); res.status(201).json(maskKvm(store.createKvm(s, o, req.body))); });
    r.get(`${prefix}/keyvaluemaps/:map`, (req, res) => {
      const [s, o] = scopeOf(req);
      const k = store.getKvm(s, o, req.params.map);
      if (!k) throw new HttpError(404, `KeyValueMap ${req.params.map} not found`);
      res.json(maskKvm(k));
    });
    r.delete(`${prefix}/keyvaluemaps/:map`, (req, res) => { const [s, o] = scopeOf(req); store.deleteKvm(s, o, req.params.map); res.json({ deleted: true }); });
    r.post(`${prefix}/keyvaluemaps/:map/entries`, json, (req, res) => {
      const [s, o] = scopeOf(req);
      if (!store.getKvm(s, o, req.params.map)) throw new HttpError(404, `KeyValueMap ${req.params.map} not found`);
      if (!req.body.name) throw new HttpError(400, 'name is required');
      store.kvmPut(s, o, req.params.map, req.body.name, req.body.value ?? '');
      res.status(201).json({ name: req.body.name });
    });
    r.delete(`${prefix}/keyvaluemaps/:map/entries/:entry`, (req, res) => {
      const [s, o] = scopeOf(req);
      if (!store.kvmDelete(s, o, req.params.map, req.params.entry)) throw new HttpError(404, `Entry ${req.params.entry} not found`);
      res.json({ deleted: true });
    });
  };
  kvmRoutes('/environments/:env', (req) => { store.checkEnv(req.params.env); return ['env', req.params.env]; });
  kvmRoutes('/apis/:api', (req) => ['api', req.params.api]);
  kvmRoutes('/kvm-org', () => ['org', store.orgName]);

  // ---------- Target servers ----------
  r.get('/environments/:env/targetservers', (req, res) => res.json(store.listTargetServers(req.params.env)));
  r.post('/environments/:env/targetservers', json, (req, res) => res.status(201).json(store.putTargetServer(req.params.env, req.body, true)));
  r.get('/environments/:env/targetservers/:name', (req, res) => {
    const ts = store.getTargetServer(req.params.env, req.params.name);
    if (!ts) throw new HttpError(404, `TargetServer ${req.params.name} not found`);
    res.json(ts);
  });
  r.put('/environments/:env/targetservers/:name', json, (req, res) => res.json(store.putTargetServer(req.params.env, { ...req.body, name: req.params.name })));
  r.delete('/environments/:env/targetservers/:name', (req, res) => { store.deleteTargetServer(req.params.env, req.params.name); res.json({ deleted: true }); });

  // ---------- Trace, logs, stats ----------
  r.get('/environments/:env/apis/:name/trace', (req, res) => res.json(runtime.traces.list(req.params.env, req.params.name)));
  r.get('/environments/:env/apis/:name/trace/:id', (req, res) => {
    const t = runtime.traces.get(req.params.env, req.params.name, req.params.id);
    if (!t) throw new HttpError(404, 'Transaction not found');
    res.json(t);
  });
  r.delete('/environments/:env/apis/:name/trace', (req, res) => { runtime.traces.clear(req.params.env, req.params.name); res.json({ cleared: true }); });
  r.post('/trace/send', json, wrap(async (req, res) => {
    const { env = 'test', verb = 'GET', path: p = '/', headers = {}, body } = req.body;
    const url = `http://127.0.0.1:${gatewayPort()}${p.startsWith('/') ? p : '/' + p}`;
    const h = { ...headers, 'x-apigee-lite-env': env };
    const t0 = Date.now();
    const opts = { method: verb, headers: h };
    if (body && !['GET', 'HEAD'].includes(verb.toUpperCase())) opts.body = body;
    const resp = await fetch(url, opts);
    const outHeaders = {};
    resp.headers.forEach((v, k) => { outHeaders[k] = v; });
    res.json({ status: resp.status, headers: outHeaders, body: await resp.text(), durationMs: Date.now() - t0 });
  }));
  r.get('/logs', (req, res) => res.json(runtime.logs.list(Number(req.query.since || 0))));
  r.delete('/logs', (req, res) => { runtime.logs.clear(); res.json({ cleared: true }); });
  r.get('/stats', (req, res) => res.json(runtime.statsList()));

  r.get('/policytemplates', (req, res) => {
    const templates = {};
    for (const type of policies.SUPPORTED) {
      const f = path.join(TEMPLATE_DIR, `${type}.xml`);
      if (fs.existsSync(f)) templates[type] = fs.readFileSync(f, 'utf8');
    }
    res.json({ categories: policies.CATEGORIES, templates });
  });

  r.use((err, req, res, next) => {
    void next;
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    res.status(status).json({ code: status, message: err.message, errors: err.errors });
  });
  return r;
}

function modelOf(b) {
  const ep = (e) => ({
    name: e.name, basePath: e.basePath,
    preFlow: e.preFlow, postFlow: e.postFlow, postClientFlow: e.postClientFlow, flows: e.flows,
    faultRules: e.faultRules, defaultFaultRule: e.defaultFaultRule, routeRules: e.routeRules, connection: e.connection,
  });
  return {
    name: b.name,
    proxyEndpoints: Object.values(b.proxyEndpoints).map(ep),
    targetEndpoints: Object.values(b.targetEndpoints).map(ep),
    policies: Object.values(b.policies).map((p) => ({ name: p.name, type: p.type, enabled: p.enabled, continueOnError: p.continueOnError, supported: policies.isSupported(p.type) })),
    sharedFlows: Object.values(b.sharedFlows),
    resources: Object.keys(b.resources),
  };
}

module.exports = { createManagementRouter };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KINDS = { apis: 'apiproxy', sharedflows: 'sharedflowbundle' };
const ENVS = ['test', 'prod'];

function emptyOrg() {
  return {
    name: 'practice',
    environments: [...ENVS],
    apiproducts: {},
    developers: {},
    kvms: { env: { test: {}, prod: {} }, api: {}, org: { practice: {} } },
    targetservers: { test: {}, prod: {} },
    deployments: { test: { apis: {}, sharedflows: {} }, prod: { apis: {}, sharedflows: {} } },
  };
}

const randomKey = (n) => crypto.randomBytes(n).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, n);
const now = () => Date.now();

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class OrgStore {
  // dataDir === null keeps everything in memory (used by tests).
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.mem = new Map();
    this.org = emptyOrg();
    if (dataDir) this.load();
  }

  get orgName() { return this.org.name; }
  get orgFile() { return path.join(this.dataDir, 'org.json'); }

  load() {
    if (this.dataDir && fs.existsSync(this.orgFile)) this.org = { ...emptyOrg(), ...JSON.parse(fs.readFileSync(this.orgFile, 'utf8')) };
  }

  save() {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.orgFile, JSON.stringify(this.org, null, 2));
  }

  checkEnv(env) { if (!this.org.environments.includes(env)) throw new HttpError(404, `Environment ${env} does not exist`); }

  // ---------- API products ----------
  listProducts() { return Object.values(this.org.apiproducts); }
  getProduct(name) { return this.org.apiproducts[name] || null; }
  createProduct(p) {
    if (!p || !p.name) throw new HttpError(400, 'name is required');
    if (this.org.apiproducts[p.name]) throw new HttpError(409, `API Product ${p.name} already exists`);
    const prod = {
      name: p.name, displayName: p.displayName || p.name, description: p.description || '', approvalType: p.approvalType || 'auto',
      proxies: p.proxies || [], environments: p.environments || [], apiResources: p.apiResources || [], scopes: p.scopes || [],
      quota: p.quota != null ? String(p.quota) : '', quotaInterval: p.quotaInterval != null ? String(p.quotaInterval) : '', quotaTimeUnit: p.quotaTimeUnit || '',
      attributes: p.attributes || [], createdAt: now(), lastModifiedAt: now(),
    };
    this.org.apiproducts[p.name] = prod;
    this.save();
    return prod;
  }
  updateProduct(name, patch) {
    const p = this.getProduct(name);
    if (!p) throw new HttpError(404, `API Product ${name} not found`);
    for (const k of ['quota', 'quotaInterval']) if (patch[k] != null) patch[k] = String(patch[k]);
    Object.assign(p, patch, { name, lastModifiedAt: now() });
    this.save();
    return p;
  }
  deleteProduct(name) {
    if (!this.getProduct(name)) throw new HttpError(404, `API Product ${name} not found`);
    delete this.org.apiproducts[name];
    this.save();
  }

  // ---------- Developers & apps ----------
  listDevelopers() { return Object.values(this.org.developers).map(({ apps, ...d }) => ({ ...d, apps: Object.keys(apps) })); }
  getDeveloperRaw(email) {
    const d = this.org.developers[String(email).toLowerCase()];
    if (!d) throw new HttpError(404, `Developer ${email} not found`);
    return d;
  }
  getDeveloper(email) { const { apps, ...d } = this.getDeveloperRaw(email); return { ...d, apps: Object.keys(apps) }; }
  createDeveloper(d) {
    if (!d || !d.email) throw new HttpError(400, 'email is required');
    const email = d.email.toLowerCase();
    if (this.org.developers[email]) throw new HttpError(409, `Developer ${email} already exists`);
    this.org.developers[email] = {
      email, firstName: d.firstName || '', lastName: d.lastName || '', userName: d.userName || email.split('@')[0],
      developerId: crypto.randomUUID(), status: 'active', attributes: d.attributes || [], createdAt: now(), apps: {},
    };
    this.save();
    return this.getDeveloper(email);
  }
  updateDeveloper(email, patch) {
    const d = this.getDeveloperRaw(email);
    for (const k of ['firstName', 'lastName', 'userName', 'attributes', 'status']) if (patch[k] !== undefined) d[k] = patch[k];
    this.save();
    return this.getDeveloper(email);
  }
  deleteDeveloper(email) { this.getDeveloperRaw(email); delete this.org.developers[String(email).toLowerCase()]; this.save(); }

  listApps(email) {
    const devs = email ? [this.getDeveloperRaw(email)] : Object.values(this.org.developers);
    return devs.flatMap((d) => Object.values(d.apps).map((a) => ({ ...a, developerEmail: d.email })));
  }
  getApp(email, name) {
    const a = this.getDeveloperRaw(email).apps[name];
    if (!a) throw new HttpError(404, `App ${name} not found for developer ${email}`);
    return a;
  }
  createApp(email, a) {
    const d = this.getDeveloperRaw(email);
    if (!a || !a.name) throw new HttpError(400, 'name is required');
    if (d.apps[a.name]) throw new HttpError(409, `App ${a.name} already exists`);
    const products = a.apiProducts || [];
    for (const p of products) if (!this.getProduct(p)) throw new HttpError(400, `API Product ${p} does not exist`);
    const key = a.consumerKey || randomKey(32);
    if (this.findByConsumerKey(key)) throw new HttpError(409, `Consumer key ${key} already exists`);
    const app = {
      name: a.name, appId: crypto.randomUUID(), callbackUrl: a.callbackUrl || '', status: 'approved', attributes: a.attributes || [], createdAt: now(),
      credentials: [{ consumerKey: key, consumerSecret: a.consumerSecret || randomKey(16), status: 'approved', issuedAt: now(), expiresAt: -1, scopes: [], apiProducts: products.map((p) => ({ apiproduct: p, status: 'approved' })) }],
    };
    d.apps[a.name] = app;
    this.save();
    return { ...app, developerEmail: d.email };
  }
  updateApp(email, name, patch) {
    const app = this.getApp(email, name);
    if (patch.callbackUrl !== undefined) app.callbackUrl = patch.callbackUrl;
    if (patch.attributes !== undefined) app.attributes = patch.attributes;
    if (patch.apiProducts !== undefined) {
      for (const p of patch.apiProducts) if (!this.getProduct(p)) throw new HttpError(400, `API Product ${p} does not exist`);
      for (const c of app.credentials) c.apiProducts = patch.apiProducts.map((p) => ({ apiproduct: p, status: 'approved' }));
    }
    this.save();
    return app;
  }
  setAppStatus(email, name, status) {
    const app = this.getApp(email, name);
    app.status = status === 'revoke' || status === 'revoked' ? 'revoked' : 'approved';
    this.save();
    return app;
  }
  setKeyStatus(email, name, key, status) {
    const cred = this.getApp(email, name).credentials.find((c) => c.consumerKey === key);
    if (!cred) throw new HttpError(404, `Key ${key} not found`);
    cred.status = status === 'revoke' || status === 'revoked' ? 'revoked' : 'approved';
    this.save();
    return cred;
  }
  deleteApp(email, name) { this.getApp(email, name); delete this.getDeveloperRaw(email).apps[name]; this.save(); }

  findByConsumerKey(key) {
    for (const developer of Object.values(this.org.developers)) {
      for (const app of Object.values(developer.apps)) {
        const credential = app.credentials.find((c) => c.consumerKey === key);
        if (credential) return { developer, app, credential };
      }
    }
    return null;
  }

  // ---------- KVMs (scope: env | api | org) ----------
  kvmBucket(scope, owner, create = false) {
    const s = this.org.kvms[scope] || (this.org.kvms[scope] = {});
    if (!s[owner] && create) s[owner] = {};
    return s[owner] || null;
  }
  listKvms(scope, owner) { return Object.values(this.kvmBucket(scope, owner) || {}); }
  getKvm(scope, owner, name) { const b = this.kvmBucket(scope, owner); return (b && b[name]) || null; }
  createKvm(scope, owner, { name, encrypted = false, entry = [] }) {
    if (!name) throw new HttpError(400, 'name is required');
    const b = this.kvmBucket(scope, owner, true);
    if (b[name]) throw new HttpError(409, `KeyValueMap ${name} already exists`);
    b[name] = { name, encrypted: !!encrypted, entry: entry.map((e) => ({ name: e.name, value: String(e.value) })) };
    this.save();
    return b[name];
  }
  deleteKvm(scope, owner, name) {
    const b = this.kvmBucket(scope, owner);
    if (!b || !b[name]) throw new HttpError(404, `KeyValueMap ${name} not found`);
    delete b[name];
    this.save();
  }
  kvmGet(scope, owner, map, key) {
    const m = this.getKvm(scope, owner, map);
    const e = m && m.entry.find((x) => x.name === key);
    return e ? e.value : null;
  }
  kvmPut(scope, owner, map, key, value) {
    let m = this.getKvm(scope, owner, map);
    if (!m) m = this.createKvm(scope, owner, { name: map });
    const e = m.entry.find((x) => x.name === key);
    if (e) e.value = String(value); else m.entry.push({ name: key, value: String(value) });
    this.save();
  }
  kvmDelete(scope, owner, map, key) {
    const m = this.getKvm(scope, owner, map);
    if (!m) return false;
    const before = m.entry.length;
    m.entry = m.entry.filter((x) => x.name !== key);
    this.save();
    return m.entry.length !== before;
  }

  // ---------- Target servers ----------
  listTargetServers(env) { this.checkEnv(env); return Object.values(this.org.targetservers[env] || {}); }
  getTargetServer(env, name) { return ((this.org.targetservers[env] || {})[name]) || null; }
  putTargetServer(env, ts, create = false) {
    this.checkEnv(env);
    if (!ts || !ts.name || !ts.host) throw new HttpError(400, 'name and host are required');
    const bucket = this.org.targetservers[env] || (this.org.targetservers[env] = {});
    if (create && bucket[ts.name]) throw new HttpError(409, `TargetServer ${ts.name} already exists`);
    bucket[ts.name] = { name: ts.name, host: ts.host, port: Number(ts.port || 80), isEnabled: ts.isEnabled !== false, sSLInfo: ts.sSLInfo || { enabled: false } };
    this.save();
    return bucket[ts.name];
  }
  deleteTargetServer(env, name) {
    if (!this.getTargetServer(env, name)) throw new HttpError(404, `TargetServer ${name} not found`);
    delete this.org.targetservers[env][name];
    this.save();
  }

  // ---------- Deployments ----------
  getDeployments(env) { this.checkEnv(env); return this.org.deployments[env]; }
  setDeployment(env, kind, name, rev) {
    const d = this.getDeployments(env);
    if (rev === null) delete d[kind][name]; else d[kind][name] = String(rev);
    this.save();
  }
  deploymentsOf(kind, name) {
    return this.org.environments.filter((e) => this.org.deployments[e][kind][name]).map((e) => ({ environment: e, revision: this.org.deployments[e][kind][name] }));
  }

  // ---------- Bundles (kind: apis | sharedflows) ----------
  bundleDir(kind, name, rev) { return path.join(this.dataDir, kind, name, ...(rev !== undefined ? [String(rev)] : [])); }

  listBundles(kind) {
    if (!this.dataDir) return [...new Set([...this.mem.keys()].filter((k) => k.startsWith(kind + '/')).map((k) => k.split('/')[1]))].sort();
    const dir = path.join(this.dataDir, kind);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.statSync(path.join(dir, n)).isDirectory()).sort() : [];
  }

  listRevisions(kind, name) {
    let revs;
    if (!this.dataDir) revs = [...this.mem.keys()].filter((k) => k.startsWith(`${kind}/${name}/`)).map((k) => k.split('/')[2]);
    else {
      const dir = this.bundleDir(kind, name);
      revs = fs.existsSync(dir) ? fs.readdirSync(dir).filter((r) => /^\d+$/.test(r)) : [];
    }
    return revs.map(Number).sort((a, b) => a - b).map(String);
  }

  readBundle(kind, name, rev) {
    if (!this.dataDir) {
      const f = this.mem.get(`${kind}/${name}/${rev}`);
      if (!f) throw new HttpError(404, `${kind === 'apis' ? 'API proxy' : 'Shared flow'} ${name} revision ${rev} not found`);
      return { ...f };
    }
    const root = this.bundleDir(kind, name, rev);
    if (!fs.existsSync(root)) throw new HttpError(404, `${kind === 'apis' ? 'API proxy' : 'Shared flow'} ${name} revision ${rev} not found`);
    const files = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files[path.relative(root, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
      }
    };
    walk(root);
    return files;
  }

  writeBundle(kind, name, rev, files) {
    const rootName = KINDS[kind];
    for (const p of Object.keys(files)) {
      if (!p.startsWith(rootName + '/') || p.includes('..') || path.isAbsolute(p)) throw new HttpError(400, `Invalid bundle path ${p}; files must live under ${rootName}/`);
    }
    if (!this.dataDir) { this.mem.set(`${kind}/${name}/${rev}`, { ...files }); return; }
    const root = this.bundleDir(kind, name, rev);
    fs.rmSync(root, { recursive: true, force: true });
    for (const [p, content] of Object.entries(files)) {
      const full = path.join(root, ...p.split('/'));
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  createRevision(kind, name, files) {
    if (!/^[A-Za-z0-9_\-.]+$/.test(name)) throw new HttpError(400, `Invalid name ${name}; use letters, digits, - _ .`);
    const revs = this.listRevisions(kind, name);
    const rev = String(revs.length ? Number(revs[revs.length - 1]) + 1 : 1);
    this.writeBundle(kind, name, rev, stampRevision(files, KINDS[kind], name, rev));
    return rev;
  }

  deleteBundle(kind, name) {
    for (const env of this.org.environments) if (this.org.deployments[env][kind][name]) throw new HttpError(409, `${name} is deployed to ${env}; undeploy it first`);
    if (!this.dataDir) { for (const k of [...this.mem.keys()]) if (k.startsWith(`${kind}/${name}/`)) this.mem.delete(k); return; }
    fs.rmSync(this.bundleDir(kind, name), { recursive: true, force: true });
    if (this.org.kvms.api[name]) { delete this.org.kvms.api[name]; this.save(); }
  }

  deleteRevision(kind, name, rev) {
    for (const env of this.org.environments) if (this.org.deployments[env][kind][name] === String(rev)) throw new HttpError(409, `Revision ${rev} is deployed to ${env}; undeploy it first`);
    if (!this.dataDir) { this.mem.delete(`${kind}/${name}/${rev}`); return; }
    fs.rmSync(this.bundleDir(kind, name, rev), { recursive: true, force: true });
  }
}

// Keeps the descriptor's name/revision attributes in sync with where the bundle is stored.
function stampRevision(files, rootName, name, rev) {
  const out = {};
  let hasDescriptor = false;
  for (const [p, c] of Object.entries(files)) {
    const rel = p.slice(rootName.length + 1);
    if (p.startsWith(rootName + '/') && !rel.includes('/') && rel.endsWith('.xml')) {
      hasDescriptor = true;
      out[`${rootName}/${name}.xml`] = c
        .replace(/(<(?:APIProxy|SharedFlowBundle)\b[^>]*?)\s+revision="[^"]*"/, '$1')
        .replace(/<(APIProxy|SharedFlowBundle)\b([^>]*?)(\/?)>/, (m, tag, attrs, selfClose) => {
          const a = attrs.replace(/\s+name="[^"]*"/, '');
          return `<${tag} revision="${rev}" name="${name}"${a}${selfClose}>`;
        });
    } else out[p] = c;
  }
  if (!hasDescriptor) {
    const tag = rootName === 'apiproxy' ? 'APIProxy' : 'SharedFlowBundle';
    out[`${rootName}/${name}.xml`] = `<${tag} revision="${rev}" name="${name}">\n    <DisplayName>${name}</DisplayName>\n    <Description/>\n</${tag}>\n`;
  }
  return out;
}

module.exports = { OrgStore, HttpError, KINDS, stampRevision };

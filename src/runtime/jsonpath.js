'use strict';
// Minimal JSONPath: $.a.b, $['a'], [n], [-n], [*], .*, ..name, [?(@.x op v)]

function tokenize(path) {
  const p = String(path).trim();
  if (!p.startsWith('$')) throw new Error(`Invalid JSONPath: ${path}`);
  const segs = [];
  let i = 1;
  while (i < p.length) {
    if (p.startsWith('..', i)) {
      i += 2;
      const m = /^(\*|[A-Za-z0-9_\-$]+)/.exec(p.slice(i));
      if (!m) throw new Error(`Invalid JSONPath: ${path}`);
      segs.push({ type: 'recurse', name: m[1] });
      i += m[1].length;
    } else if (p[i] === '.') {
      i++;
      const m = /^(\*|[A-Za-z0-9_\-$@]+)/.exec(p.slice(i));
      if (!m) throw new Error(`Invalid JSONPath: ${path}`);
      segs.push(m[1] === '*' ? { type: 'wild' } : { type: 'key', name: m[1] });
      i += m[1].length;
    } else if (p[i] === '[') {
      const end = findClose(p, i);
      const inner = p.slice(i + 1, end).trim();
      i = end + 1;
      if (inner === '*') segs.push({ type: 'wild' });
      else if (/^-?\d+$/.test(inner)) segs.push({ type: 'index', n: Number(inner) });
      else if (/^['"].*['"]$/.test(inner)) segs.push({ type: 'key', name: inner.slice(1, -1) });
      else if (inner.startsWith('?(') && inner.endsWith(')')) segs.push({ type: 'filter', expr: inner.slice(2, -1).trim() });
      else throw new Error(`Unsupported JSONPath segment [${inner}]`);
    } else throw new Error(`Invalid JSONPath: ${path}`);
  }
  return segs;
}

function findClose(p, start) {
  let q = null;
  for (let j = start + 1; j < p.length; j++) {
    const c = p[j];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === ']') return j;
  }
  throw new Error(`Unclosed [ in JSONPath: ${p}`);
}

function children(v) {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') return Object.values(v);
  return [];
}

function descendants(v, out = []) {
  out.push(v);
  for (const c of children(v)) descendants(c, out);
  return out;
}

function filterMatch(item, expr) {
  const m = /^@\.([A-Za-z0-9_.\-]+)\s*(==|!=|>=|<=|>|<)?\s*(.*)$/.exec(expr);
  if (!m) throw new Error(`Unsupported filter: ${expr}`);
  let v = item;
  for (const k of m[1].split('.')) v = v == null ? undefined : v[k];
  if (!m[2]) return v !== undefined;
  let rhs = m[3].trim();
  if (/^['"].*['"]$/.test(rhs)) rhs = rhs.slice(1, -1);
  else if (rhs === 'true' || rhs === 'false') rhs = rhs === 'true';
  else if (!isNaN(Number(rhs))) rhs = Number(rhs);
  switch (m[2]) {
    case '==': return v == rhs;
    case '!=': return v != rhs;
    case '>': return v > rhs;
    case '<': return v < rhs;
    case '>=': return v >= rhs;
    default: return v <= rhs;
  }
}

function query(doc, path) {
  let cur = [doc];
  for (const s of tokenize(path)) {
    const next = [];
    for (const v of cur) {
      if (s.type === 'key') {
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, s.name)) next.push(v[s.name]);
      } else if (s.type === 'index') {
        if (Array.isArray(v)) {
          const idx = s.n < 0 ? v.length + s.n : s.n;
          if (idx >= 0 && idx < v.length) next.push(v[idx]);
        }
      } else if (s.type === 'wild') next.push(...children(v));
      else if (s.type === 'filter') next.push(...children(v).filter((c) => c && typeof c === 'object' && filterMatch(c, s.expr)));
      else if (s.type === 'recurse') {
        for (const d of descendants(v)) {
          if (s.name === '*') next.push(...children(d));
          else if (d && typeof d === 'object' && !Array.isArray(d) && Object.prototype.hasOwnProperty.call(d, s.name)) next.push(d[s.name]);
        }
      }
    }
    cur = next;
  }
  return cur;
}

module.exports = { query };

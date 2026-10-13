'use strict';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function resolveTemplate(str, get, opts = {}) {
  if (str == null) return '';
  const prefix = opts.prefix || '{';
  const suffix = opts.suffix || '}';
  const re = new RegExp(esc(prefix) + '([A-Za-z_][A-Za-z0-9_.\\-]*)' + esc(suffix), 'g');
  return String(str).replace(re, (m, name) => {
    const v = get(name);
    if (v === null || v === undefined) {
      if (opts.strict) throw new Error(`Unresolved variable : ${name}`);
      return '';
    }
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

module.exports = { resolveTemplate };

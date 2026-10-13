'use strict';
// Apigee Edge condition language: parser + evaluator.

const WORD_OPS = {
  and: 'and', or: 'or', not: 'not',
  equals: '=', is: '=', notequals: '!=', isnot: '!=',
  equalscaseinsensitive: ':=',
  greaterthan: '>', greaterthanorequals: '>=', lesserthan: '<', lesserthanorequals: '<=',
  matches: '~', like: '~', matchespath: '~/', likepath: '~/', javaregex: '~~', startswith: '=|',
};
const SYM_OPS = ['~~', '~/', ':=', '==', '!=', '>=', '<=', '=|', '&&', '||', '=', '>', '<', '~', '!'];
const COMPARATORS = new Set(['=', '==', '!=', ':=', '>', '>=', '<', '<=', '~', '~/', '~~', '=|']);

function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')') { tokens.push({ t: c }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j++];
      }
      if (j >= src.length) throw new Error(`Unterminated string in condition: ${src}`);
      tokens.push({ t: 'str', v: s }); i = j + 1; continue;
    }
    const sym = SYM_OPS.find((op) => src.startsWith(op, i));
    if (sym && !(sym === '~/' && false)) {
      let op = sym === '==' ? '=' : sym;
      if (op === '&&') op = 'and';
      if (op === '||') op = 'or';
      if (op === '!') op = 'not';
      tokens.push({ t: 'op', v: op }); i += sym.length; continue;
    }
    let j = i;
    while (j < src.length && !/[\s()"'=!<>~&|]/.test(src[j])) j++;
    if (j === i) throw new Error(`Unexpected character '${c}' in condition: ${src}`);
    const w = src.slice(i, j);
    const op = WORD_OPS[w.toLowerCase()];
    tokens.push(op ? { t: 'op', v: op } : { t: 'word', v: w });
    i = j;
  }
  return tokens;
}

function parse(src) {
  if (src == null || String(src).trim() === '') return { k: 'lit', v: true };
  const tokens = tokenize(String(src));
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v) => peek() && peek().t === 'op' && peek().v === v;
  function orExpr() {
    let left = andExpr();
    while (isOp('or')) { p++; left = { k: 'or', a: left, b: andExpr() }; }
    return left;
  }
  function andExpr() {
    let left = unary();
    while (isOp('and')) { p++; left = { k: 'and', a: left, b: unary() }; }
    return left;
  }
  function unary() {
    if (isOp('not')) { p++; return { k: 'not', a: unary() }; }
    return primary();
  }
  function operand(side) {
    const tk = tokens[p++];
    if (!tk) throw new Error(`Unexpected end of condition: ${src}`);
    if (tk.t === 'str') return { k: 'lit', v: tk.v };
    if (tk.t !== 'word') throw new Error(`Unexpected token '${tk.v || tk.t}' in condition: ${src}`);
    const lw = tk.v.toLowerCase();
    if (lw === 'null') return { k: 'lit', v: null };
    if (side === 'right') return { k: 'lit', v: tk.v };
    if (lw === 'true' || lw === 'false') return { k: 'lit', v: lw === 'true' };
    if (/^-?\d+(\.\d+)?$/.test(tk.v)) return { k: 'lit', v: tk.v };
    return { k: 'var', v: tk.v };
  }
  function primary() {
    if (peek() && peek().t === '(') {
      p++;
      const e = orExpr();
      if (!peek() || peek().t !== ')') throw new Error(`Missing ')' in condition: ${src}`);
      p++;
      return e;
    }
    const left = operand('left');
    if (peek() && peek().t === 'op' && COMPARATORS.has(peek().v)) {
      const op = tokens[p++].v;
      return { k: 'cmp', op, a: left, b: operand('right') };
    }
    return { k: 'bare', a: left };
  }
  const ast = orExpr();
  if (p < tokens.length) throw new Error(`Unexpected token '${tokens[p].v || tokens[p].t}' in condition: ${src}`);
  return ast;
}

const isNum = (v) => v !== null && v !== '' && typeof v !== 'boolean' && !isNaN(Number(v));
const escapeRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

function pathPatternToRegex(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') { re += '.*'; i++; }
    else if (pattern[i] === '*') re += '[^/]*';
    else re += escapeRe(pattern[i]);
  }
  return new RegExp(`^${re}$`);
}

function compare(op, l, r) {
  if (op === '=' || op === '!=') {
    let eq;
    if (r === null || l === null) eq = l === r || (l == null && r == null);
    else if (isNum(l) && isNum(r)) eq = Number(l) === Number(r);
    else eq = String(l) === String(r);
    return op === '=' ? eq : !eq;
  }
  if (l === null || l === undefined || r === null) return false;
  const ls = String(l), rs = String(r);
  switch (op) {
    case ':=': return ls.toLowerCase() === rs.toLowerCase();
    case '>': case '>=': case '<': case '<=': {
      const [a, b] = isNum(l) && isNum(r) ? [Number(l), Number(r)] : [ls, rs];
      if (op === '>') return a > b;
      if (op === '>=') return a >= b;
      if (op === '<') return a < b;
      return a <= b;
    }
    case '~': return new RegExp(`^${rs.split('*').map(escapeRe).join('.*')}$`).test(ls);
    case '~/': return pathPatternToRegex(rs).test(ls);
    case '~~': return new RegExp(`^(?:${rs})$`).test(ls);
    case '=|': return ls.startsWith(rs);
    default: throw new Error(`Unknown operator ${op}`);
  }
}

function evalNode(n, get) {
  switch (n.k) {
    case 'lit': return n.v;
    case 'var': { const v = get(n.v); return v === undefined ? null : v; }
    case 'and': return truthy(evalNode(n.a, get)) && truthy(evalNode(n.b, get));
    case 'or': return truthy(evalNode(n.a, get)) || truthy(evalNode(n.b, get));
    case 'not': return !truthy(evalNode(n.a, get));
    case 'bare': return truthy(evalNode(n.a, get));
    case 'cmp': return compare(n.op, evalNode(n.a, get), evalNode(n.b, get));
    default: throw new Error('bad node');
  }
}

function truthy(v) {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'string' && (v === '' || v.toLowerCase() === 'false')) return false;
  return true;
}

const cache = new Map();
function evaluate(src, get) {
  const key = src == null ? '' : String(src);
  let ast = cache.get(key);
  if (!ast) { ast = parse(key); cache.set(key, ast); }
  return truthy(evalNode(ast, get));
}

module.exports = { parse, evaluate, tokenize };

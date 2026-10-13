'use strict';
/* Minimal syntax highlighter for the Develop editor (XML, JavaScript, JSON). Output is always HTML-escaped. */
(function () {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, s) => `<span class="tok-${cls}">${esc(s)}</span>`;

  function withVars(text, baseCls) {
    let out = '';
    let last = 0;
    const re = /\{[A-Za-z_][\w.\-]*\}/g;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) out += baseCls ? span(baseCls, text.slice(last, m.index)) : esc(text.slice(last, m.index));
      out += span('var', m[0]);
      last = re.lastIndex;
    }
    if (last < text.length) out += baseCls ? span(baseCls, text.slice(last)) : esc(text.slice(last));
    return out;
  }

  function tag(src) {
    const m = /^(<\/?|<\?)([\w:.\-]*)([\s\S]*?)(\/?>|\?>)?$/.exec(src);
    if (!m) return esc(src);
    let out = span('punct', m[1]) + span(m[1] === '<?' ? 'decl' : 'tag', m[2]);
    const attrRe = /(\s+)([\w:.\-]+)(\s*=\s*)?("[^"]*"?|'[^']*'?)?|([\s\S])/g;
    let a;
    while ((a = attrRe.exec(m[3]))) {
      if (a[5] !== undefined) { out += esc(a[5]); continue; }
      out += esc(a[1]) + span('attr', a[2]);
      if (a[3]) out += span('punct', a[3]);
      if (a[4]) out += withVars(a[4], 'value');
    }
    if (m[4]) out += span('punct', m[4]);
    return out;
  }

  function xml(code) {
    let out = '';
    const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[?\/]?[\w:.\-]*(?:"[^"]*"|'[^']*'|[^<>"'])*>?/g;
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      if (m.index > last) out += withVars(code.slice(last, m.index), 'text');
      const t = m[0];
      if (t.startsWith('<!--')) out += span('comment', t);
      else if (t.startsWith('<![CDATA[')) out += withVars(t, 'cdata');
      else out += tag(t);
      last = re.lastIndex;
      if (!t.length) re.lastIndex++;
    }
    if (last < code.length) out += withVars(code.slice(last), 'text');
    return out;
  }

  const JS_KEYWORDS = new Set(('var let const function return if else for while do break continue new typeof instanceof in of ' +
    'try catch finally throw switch case default this delete void class extends super async await yield').split(' '));
  const JS_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
  const JS_BUILTINS = new Set(['context', 'print', 'request', 'response', 'JSON', 'Math', 'Date', 'Object', 'Array',
    'String', 'Number', 'parseInt', 'parseFloat', 'httpClient', 'crypto', 'properties']);

  function js(code) {
    let out = '';
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?)|(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)|([A-Za-z_$][\w$]*)|([\s\S])/gi;
    let m;
    while ((m = re.exec(code))) {
      if (m[1]) out += span('comment', m[1]);
      else if (m[2]) out += span('string', m[2]);
      else if (m[3]) out += span('number', m[3]);
      else if (m[4]) {
        const w = m[4];
        const prev = code.slice(0, m.index).trimEnd().slice(-1);
        const next = code.slice(re.lastIndex).trimStart().charAt(0);
        if (prev === '.') out += next === '(' ? span('fn', w) : span('prop', w);
        else if (JS_KEYWORDS.has(w)) out += span('keyword', w);
        else if (JS_LITERALS.has(w)) out += span('literal', w);
        else if (JS_BUILTINS.has(w)) out += span('builtin', w);
        else if (next === '(') out += span('fn', w);
        else out += esc(w);
      } else out += esc(m[5]);
    }
    return out;
  }

  function json(code) {
    let out = '';
    const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)|\b(true|false|null)\b|([\s\S])/gi;
    let m;
    while ((m = re.exec(code))) {
      if (m[1]) out += m[2] ? span('attr', m[1]) + esc(m[2]) : span('value', m[1]);
      else if (m[3]) out += span('number', m[3]);
      else if (m[4]) out += span('literal', m[4]);
      else out += esc(m[5]);
    }
    return out;
  }

  function langFor(path) {
    if (/\.xml$/i.test(path || '')) return 'xml';
    if (/\.js$/i.test(path || '')) return 'js';
    if (/\.json$/i.test(path || '')) return 'json';
    return 'text';
  }

  function highlight(code, lang) {
    code = code == null ? '' : String(code);
    if (lang === 'xml') return xml(code);
    if (lang === 'js') return js(code);
    if (lang === 'json') return json(code);
    return esc(code);
  }

  window.Highlight = { highlight, langFor, escape: esc };
})();

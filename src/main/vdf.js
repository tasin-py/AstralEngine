'use strict';
// Minimal parser for Valve's text KeyValues format (.vdf / .acf).

function parseVdf(text) {
  let i = 0;
  const n = text.length;
  const root = {};
  const stack = [root];

  function skipWs() {
    while (i < n) {
      const c = text[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') { i++; continue; }
      if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  }
  function readToken() {
    skipWs();
    if (i >= n) return null;
    const c = text[i];
    if (c === '{' || c === '}') { i++; return { brace: c }; }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else s += text[i++];
      }
      i++;
      return { str: s };
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i])) s += text[i++];
    return { str: s };
  }

  for (;;) {
    const t = readToken();
    if (!t) break;
    const cur = stack[stack.length - 1];
    if (t.brace === '}') { if (stack.length > 1) stack.pop(); continue; }
    if (t.brace === '{') continue; // malformed, ignore
    const key = t.str;
    const v = readToken();
    if (!v) break;
    if (v.brace === '{') {
      const obj = {};
      cur[key] = obj;
      stack.push(obj);
    } else if (v.brace === '}') {
      stack.pop();
    } else {
      cur[key] = v.str;
    }
  }
  return root;
}

module.exports = { parseVdf };

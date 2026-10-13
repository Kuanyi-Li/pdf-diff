/* Core logic: PDF text -> lines, and line/word diff.
 * Works in the browser (global PdfDiffCore) and in Node (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('diff'));
  else root.PdfDiffCore = factory(root.Diff);
})(typeof self !== 'undefined' ? self : this, function (Diff) {
  'use strict';

  var CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

  /** Convert pdf.js text items of one page into visual lines (keeps stream order). */
  function itemsToLines(items, page) {
    var lines = [];
    var cur = null;
    function flush() {
      if (cur) {
        var text = cur.text.replace(/\s+/g, ' ').trim();
        if (text) lines.push({ text: text, page: page });
      }
      cur = null;
    }
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it.str !== 'string') continue;
      var x = it.transform[4], y = it.transform[5];
      var h = it.height || Math.abs(it.transform[3]) || 10;
      var w = it.width || 0;
      if (it.str === '') {
        if (it.hasEOL) flush();
        continue;
      }
      if (cur && Math.abs(y - cur.y) > Math.max(2, h * 0.5)) flush();
      if (!cur) {
        cur = { text: it.str, y: y, endX: x + w, h: h };
      } else {
        var gap = x - cur.endX;
        var prevCh = cur.text.slice(-1), nextCh = it.str.charAt(0);
        var needSpace = gap > cur.h * 0.15 && !/\s/.test(prevCh) && !/\s/.test(nextCh) &&
          !(CJK.test(prevCh) && CJK.test(nextCh));
        cur.text += (needSpace ? ' ' : '') + it.str;
        cur.endX = x + w;
        cur.y = y;
      }
      if (it.hasEOL) flush();
    }
    flush();
    return lines;
  }

  function norm(text, opts) {
    var t = text.replace(/\s+/g, ' ').trim();
    if (opts.ignoreSpaces) t = t.replace(/\s+/g, '');
    if (opts.ignoreCase) t = t.toLowerCase();
    return t;
  }

  var TOKEN = /[⺀-鿿豈-﫿＀-￯　-〿]|[A-Za-z0-9_À-ɏ]+|\s+|[\s\S]/g;
  function tokenize(s) { return s.match(TOKEN) || []; }

  function bigrams(s) {
    var m = {}, n = 0;
    for (var i = 0; i < s.length - 1; i++) { var g = s.substr(i, 2); m[g] = (m[g] || 0) + 1; n++; }
    return { m: m, n: n };
  }
  function similarity(a, b) {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    var A = bigrams(a), B = bigrams(b), inter = 0;
    for (var g in A.m) if (B.m[g]) inter += Math.min(A.m[g], B.m[g]);
    return (2 * inter) / (A.n + B.n);
  }

  /** Word/char level diff of two lines -> parts for each side. */
  function inlineDiff(a, b, opts) {
    var ta = tokenize(a), tb = tokenize(b);
    var isWs = function (t) { return /^\s+$/.test(t); };
    var changes = Diff.diffArrays(ta, tb, {
      comparator: function (l, r) {
        if (opts.ignoreSpaces && isWs(l) && isWs(r)) return true;
        if (opts.ignoreCase) return l.toLowerCase() === r.toLowerCase();
        return l === r;
      }
    });
    var left = [], right = [], ia = 0, ib = 0;
    function push(arr, t, text) {
      if (!text) return;
      var last = arr[arr.length - 1];
      if (last && last.t === t) last.text += text; else arr.push({ t: t, text: text });
    }
    changes.forEach(function (c) {
      var n = c.value.length;
      if (c.added) { push(right, 'add', tb.slice(ib, ib + n).join('')); ib += n; }
      else if (c.removed) { push(left, 'del', ta.slice(ia, ia + n).join('')); ia += n; }
      else {
        push(left, 'same', ta.slice(ia, ia + n).join(''));
        push(right, 'same', tb.slice(ib, ib + n).join(''));
        ia += n; ib += n;
      }
    });
    return { left: left, right: right };
  }

  /** Pair up lines of a changed hunk by similarity (order preserving). */
  function pairHunk(aIdx, bIdx, na, nb) {
    var out = [];
    if (!aIdx.length || !bIdx.length || aIdx.length * bIdx.length > 40000) {
      var n = Math.min(aIdx.length, bIdx.length);
      if (aIdx.length * bIdx.length > 40000) {
        for (var k = 0; k < n; k++) out.push({ a: aIdx[k], b: bIdx[k] });
        aIdx = aIdx.slice(n); bIdx = bIdx.slice(n);
      }
      aIdx.forEach(function (i) { out.push({ a: i, b: null }); });
      bIdx.forEach(function (j) { out.push({ a: null, b: j }); });
      return out;
    }
    var bi = 0;
    for (var ai = 0; ai < aIdx.length; ai++) {
      var best = -1, bestSim = 0.4;
      for (var j = bi; j < bIdx.length; j++) {
        var s = similarity(na[aIdx[ai]], nb[bIdx[j]]);
        if (s > bestSim) { bestSim = s; best = j; }
      }
      if (best === -1) {
        out.push({ a: aIdx[ai], b: null });
      } else {
        for (; bi < best; bi++) out.push({ a: null, b: bIdx[bi] });
        out.push({ a: aIdx[ai], b: bIdx[best] });
        bi = best + 1;
      }
    }
    for (; bi < bIdx.length; bi++) out.push({ a: null, b: bIdx[bi] });
    return out;
  }

  /**
   * aLines / bLines: [{text, page}]. Returns {rows, stats}.
   * row: {type:'same'|'mod'|'del'|'add', a, b}; side = {no, page, parts:[{t,text}]}
   */
  function computeDiff(aLines, bLines, opts) {
    opts = opts || {};
    var na = aLines.map(function (l) { return norm(l.text, opts); });
    var nb = bLines.map(function (l) { return norm(l.text, opts); });
    var changes = Diff.diffArrays(na, nb);
    var rows = [];
    var ia = 0, ib = 0;

    function side(lines, i, parts) {
      return { no: i + 1, page: lines[i].page, parts: parts || [{ t: 'same', text: lines[i].text }] };
    }
    function flushHunk(removed, added) {
      pairHunk(removed, added, na, nb).forEach(function (p) {
        if (p.a !== null && p.b !== null) {
          var d = inlineDiff(aLines[p.a].text, bLines[p.b].text, opts);
          rows.push({ type: 'mod', a: side(aLines, p.a, d.left), b: side(bLines, p.b, d.right) });
        } else if (p.a !== null) {
          rows.push({ type: 'del', a: side(aLines, p.a, [{ t: 'del', text: aLines[p.a].text }]), b: null });
        } else {
          rows.push({ type: 'add', a: null, b: side(bLines, p.b, [{ t: 'add', text: bLines[p.b].text }]) });
        }
      });
    }

    var removed = [], added = [];
    changes.forEach(function (c) {
      var n = c.value.length, k;
      if (c.removed) { for (k = 0; k < n; k++) removed.push(ia++); }
      else if (c.added) { for (k = 0; k < n; k++) added.push(ib++); }
      else {
        if (removed.length || added.length) { flushHunk(removed, added); removed = []; added = []; }
        for (k = 0; k < n; k++) {
          rows.push({ type: 'same', a: side(aLines, ia), b: side(bLines, ib) });
          ia++; ib++;
        }
      }
    });
    if (removed.length || added.length) flushHunk(removed, added);

    var stats = { same: 0, mod: 0, del: 0, add: 0, blocks: 0 };
    var inBlock = false;
    rows.forEach(function (r) {
      stats[r.type]++;
      var isDiff = r.type !== 'same';
      if (isDiff && !inBlock) stats.blocks++;
      inBlock = isDiff;
    });
    return { rows: rows, stats: stats };
  }

  return { itemsToLines: itemsToLines, computeDiff: computeDiff, norm: norm };
});

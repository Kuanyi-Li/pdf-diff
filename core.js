/* Core logic: PDF text -> lines (with geometry), line/word diff, and highlight rectangles.
 * Works in the browser (global PdfDiffCore) and in Node (for tests). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('diff'));
  else root.PdfDiffCore = factory(root.Diff);
})(typeof self !== 'undefined' ? self : this, function (Diff) {
  'use strict';

  var CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

  // pdf.js Util.transform: apply m2 first, then m1
  function mul(m1, m2) {
    return [
      m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
      m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
      m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
    ];
  }
  function invert(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    return [
      m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
      (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det
    ];
  }
  function apply(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

  /**
   * Convert pdf.js text items of one page into visual lines (keeps stream order).
   * viewport = page.getViewport({scale: 1}) (handles /Rotate). All geometry is kept in
   * viewport space (origin top-left, y down) so that rotated pages behave like upright ones.
   * line = {text, page, zone, vt, items:[{s, e, x, y, w, h, dx, dy, ux, uy}]}
   *   (s/e = char offsets in text; (x,y) = baseline start; d = text direction; u = "up" direction)
   */
  function itemsToLines(items, page, viewport) {
    var lines = [];
    var cur = null;
    var vt = viewport ? viewport.transform : [1, 0, 0, -1, 0, 0];
    var vh = viewport ? viewport.height : 0;

    function flush() {
      if (cur && /\S/.test(cur.text)) {
        var rel = vh ? cur.y / vh : 0.5;
        lines.push({
          text: cur.text, page: page, items: cur.items, vt: vt,
          zone: rel < 0.13 ? 'top' : (rel > 0.87 ? 'bottom' : null)
        });
      }
      cur = null;
    }

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (typeof it.str !== 'string') continue;
      var tr = mul(vt, it.transform);
      var x = tr[4], y = tr[5];
      var dl = Math.hypot(tr[0], tr[1]) || 1, ul = Math.hypot(tr[2], tr[3]) || 1;
      var dx = tr[0] / dl, dy = tr[1] / dl, ux = tr[2] / ul, uy = tr[3] / ul;
      var h = it.height || ul || 10;
      var w = it.width || 0;
      var upright = Math.abs(dy) < 0.1;
      if (it.str === '') {
        if (it.hasEOL) flush();
        continue;
      }
      if (cur && Math.abs(y - cur.y) > Math.max(2, h * 0.5)) flush();
      if (!cur) cur = { text: '', y: y, endX: x, h: h, items: [] };
      else if (upright) {
        var gap = x - cur.endX;
        var prevCh = cur.text.slice(-1), nextCh = it.str.charAt(0);
        var needSpace = gap > cur.h * 0.15 && !/\s/.test(prevCh) && !/\s/.test(nextCh) &&
          !(CJK.test(prevCh) && CJK.test(nextCh));
        if (needSpace) cur.text += ' ';
      }
      var s = cur.text.length;
      cur.text += it.str;
      cur.items.push({ s: s, e: cur.text.length, x: x, y: y, w: w, h: h, dx: dx, dy: dy, ux: ux, uy: uy });
      cur.endX = x + w * dx;
      cur.y = y;
      if (it.hasEOL) flush();
    }
    flush();
    return lines;
  }

  /**
   * Drop header/footer lines that repeat on many pages (e.g. "Generated on <date>", "Page n of N").
   * Digits are ignored when deciding whether two lines are "the same" line.
   */
  function headerKey(l) {
    return l.zone + '|' + l.text
      .replace(/\d+/g, '#')
      .replace(/\bpage\s*#(\s*(of|\/)\s*#)?/gi, '')
      .replace(/\u7b2c\s*#\s*\u9801(\s*[,\uff0c]?\s*\u5171\s*#\s*\u9801)?/g, '')
      .replace(/\s+/g, ' ').trim();
  }

  function dropRepeatedHeaders(lines, numPages) {
    var seen = {};
    lines.forEach(function (l) {
      if (!l.zone) return;
      (seen[headerKey(l)] = seen[headerKey(l)] || {})[l.page] = true;
    });
    var min = Math.max(3, Math.floor(numPages * 0.1));
    var dropped = 0;
    var kept = lines.filter(function (l) {
      if (!l.zone) return true;
      if (Object.keys(seen[headerKey(l)]).length >= min) { dropped++; return false; }
      return true;
    });
    return { lines: kept, dropped: dropped };
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

  /** Word/char level diff of two lines -> parts for each side (with char offsets s/e). */
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
    var left = [], right = [], ia = 0, ib = 0, ca = 0, cb = 0;
    function push(arr, t, text, start) {
      if (!text) return;
      var last = arr[arr.length - 1];
      if (last && last.t === t) { last.text += text; last.e += text.length; }
      else arr.push({ t: t, text: text, s: start, e: start + text.length });
    }
    changes.forEach(function (c) {
      var n = c.value.length, ts;
      if (c.added) { ts = tb.slice(ib, ib + n).join(''); push(right, 'add', ts, cb); ib += n; cb += ts.length; }
      else if (c.removed) { ts = ta.slice(ia, ia + n).join(''); push(left, 'del', ts, ca); ia += n; ca += ts.length; }
      else {
        var sa = ta.slice(ia, ia + n).join(''), sb = tb.slice(ib, ib + n).join('');
        push(left, 'same', sa, ca); push(right, 'same', sb, cb);
        ia += n; ib += n; ca += sa.length; cb += sb.length;
      }
    });
    return { left: coalesce(left), right: coalesce(right) };
  }

  /** Fold a short punctuation/space-only "same" part sitting between two changes of the same kind into one change. */
  function coalesce(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], prev = out[out.length - 1], next = parts[i + 1];
      if (p.t === 'same' && prev && next && prev.t !== 'same' && next.t === prev.t &&
          p.text.length <= 2 && /^[^A-Za-z0-9\u00c0-\u024f\u2e80-\u9fff]*$/.test(p.text)) {
        prev.text += p.text + next.text; prev.e = next.e;
        i++;
      } else if (prev && prev.t === p.t) {
        prev.text += p.text; prev.e = p.e;
      } else out.push({ t: p.t, text: p.text, s: p.s, e: p.e });
    }
    return out;
  }

  /** Pair up lines of a changed hunk by similarity (order preserving). */
  function pairHunk(aIdx, bIdx, na, nb) {
    var out = [];
    if (!aIdx.length || !bIdx.length || aIdx.length * bIdx.length > 250000) {
      if (aIdx.length && bIdx.length) {   // huge hunk: pair by position
        var n = Math.min(aIdx.length, bIdx.length);
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
   * aLines / bLines: [{text, page, ...}]. Returns {rows, stats}.
   * row: {type:'same'|'mod'|'del'|'add', a, b}; side = {no, idx, page, parts:[{t,text,s,e}]}
   */
  function computeDiff(aLines, bLines, opts) {
    opts = opts || {};
    var na = aLines.map(function (l) { return norm(l.text, opts); });
    var nb = bLines.map(function (l) { return norm(l.text, opts); });
    var changes = Diff.diffArrays(na, nb);
    var rows = [];
    var ia = 0, ib = 0;

    function side(lines, i, parts) {
      return {
        no: i + 1, idx: i, page: lines[i].page,
        parts: parts || [{ t: 'same', text: lines[i].text, s: 0, e: lines[i].text.length }]
      };
    }
    function whole(lines, i, t) {
      return [{ t: t, text: lines[i].text, s: 0, e: lines[i].text.length }];
    }
    function flushHunk(removed, added) {
      pairHunk(removed, added, na, nb).forEach(function (p) {
        if (p.a !== null && p.b !== null) {
          var d = inlineDiff(aLines[p.a].text, bLines[p.b].text, opts);
          rows.push({ type: 'mod', a: side(aLines, p.a, d.left), b: side(bLines, p.b, d.right) });
        } else if (p.a !== null) {
          rows.push({ type: 'del', a: side(aLines, p.a, whole(aLines, p.a, 'del')), b: null });
        } else {
          rows.push({ type: 'add', a: null, b: side(bLines, p.b, whole(bLines, p.b, 'add')) });
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

  /* ---------- highlight rectangles ---------- */

  // rough glyph advance widths (Helvetica-like) used to split a text run into sub-ranges
  function cw(ch) {
    if (CJK.test(ch)) return 1;
    if (ch === ' ') return 0.28;
    if (/[il.,:;'|!]/.test(ch)) return 0.24;
    if (/[ftjr()\[\]\-\/\\]/.test(ch)) return 0.33;
    if (/[mMwW@%]/.test(ch)) return 0.85;
    if (/[A-Z]/.test(ch)) return 0.68;
    if (/[0-9]/.test(ch)) return 0.556;
    return 0.52;
  }

  function rangeRects(line, cs, ce) {
    var rects = [];
    line.items.forEach(function (it) {
      var a = Math.max(cs, it.s), b = Math.min(ce, it.e);
      if (a >= b) return;
      var str = line.text.slice(it.s, it.e), total = 0, pre = 0, mid = 0, i;
      for (i = 0; i < str.length; i++) {
        var w = cw(str.charAt(i));
        total += w;
        if (i < a - it.s) pre += w; else if (i < b - it.s) mid += w;
      }
      var width = it.w > 0 ? it.w : it.h * 0.5 * str.length;
      var t0 = width * pre / total, t1 = t0 + width * mid / total;
      // corners in viewport space: along the text direction, from -0.22h (descender) to +0.85h (ascender)
      var xs = [], ys = [];
      [t0, t1].forEach(function (t) {
        [-0.22, 0.85].forEach(function (k) {
          xs.push(it.x + it.dx * t + it.ux * it.h * k);
          ys.push(it.y + it.dy * t + it.uy * it.h * k);
        });
      });
      rects.push({
        x0: Math.min.apply(null, xs), x1: Math.max.apply(null, xs),
        y0: Math.min.apply(null, ys), y1: Math.max.apply(null, ys),
        upright: Math.abs(it.dy) < 0.1, h: it.h
      });
    });
    return rects;
  }

  /** Merge rectangles that touch on the same (upright) text line. */
  function mergeRects(rects) {
    var out = [];
    rects.forEach(function (r) {
      var last = out[out.length - 1];
      if (last && last.upright && r.upright && Math.abs(last.y0 - r.y0) < 1 && Math.abs(last.y1 - r.y1) < 1 &&
          r.x0 - last.x1 < r.h * 0.6 && r.x0 >= last.x0 - 1) {
        last.x1 = Math.max(last.x1, r.x1);
      } else out.push({ x0: r.x0, x1: r.x1, y0: r.y0, y1: r.y1, upright: r.upright, h: r.h });
    });
    return out;
  }

  /** viewport-space rect -> PDF user-space rect (y up), via the inverse viewport transform. */
  function toPdfRect(r, vt) {
    var inv = invert(vt);
    var p = apply(inv, r.x0, r.y0), q = apply(inv, r.x1, r.y1);
    return { x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]), y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) };
  }

  /**
   * Build highlight rectangles (PDF user space) from diff rows.
   * Returns {a: {page: [rect]}, b: {page: [rect]}, countA, countB}
   */
  function collectMarks(rows, aLines, bLines) {
    var res = { a: {}, b: {}, countA: 0, countB: 0 };
    function add(target, key, lines, side, want) {
      if (!side) return;
      var line = lines[side.idx];
      side.parts.forEach(function (p) {
        if (p.t !== want || !/\S/.test(p.text)) return;
        var cs = p.s, ce = p.e;
        while (cs < ce && /\s/.test(line.text.charAt(cs))) cs++;
        while (ce > cs && /\s/.test(line.text.charAt(ce - 1))) ce--;
        var rects = mergeRects(rangeRects(line, cs, ce));
        if (!rects.length) return;
        var list = (target[line.page] = target[line.page] || []);
        rects.forEach(function (r) { list.push(toPdfRect(r, line.vt)); });
        res[key] += rects.length;
      });
    }
    rows.forEach(function (r) {
      if (r.type === 'same') return;
      add(res.a, 'countA', aLines, r.a, 'del');
      add(res.b, 'countB', bLines, r.b, 'add');
    });
    return res;
  }

  return {
    itemsToLines: itemsToLines, dropRepeatedHeaders: dropRepeatedHeaders,
    computeDiff: computeDiff, collectMarks: collectMarks, norm: norm
  };
});

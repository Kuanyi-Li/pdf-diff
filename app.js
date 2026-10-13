(function () {
  'use strict';

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    A: { file: null, raw: null, pages: 0, buf: null },
    B: { file: null, raw: null, pages: 0, buf: null },
    marks: null
  };
  var blocks = [];   // first row element of every diff block
  var cur = -1;
  var hasResult = false;

  function setStatus(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function extractPdf(file, onProgress) {
    return file.arrayBuffer().then(function (buf) {
      var task = pdfjsLib.getDocument({
        data: new Uint8Array(buf.slice(0)),   // pdf.js may detach its copy; keep `buf` for pdf-lib
        cMapUrl: 'vendor/cmaps/',
        cMapPacked: true
      });
      task.onPassword = function (update, reason) {
        var msg = reason === 2 ? '密碼錯誤，請重新輸入「' + file.name + '」的密碼：' : '「' + file.name + '」已加密，請輸入密碼：';
        var pw = window.prompt(msg);
        if (pw) update(pw); else task.destroy();
      };
      return task.promise.then(function (doc) {
        var lines = [], chain = Promise.resolve();
        for (var p = 1; p <= doc.numPages; p++) {
          (function (p) {
            chain = chain.then(function () { return doc.getPage(p); })
              .then(function (page) {
                var vp = page.getViewport({ scale: 1 });
                return page.getTextContent().then(function (tc) {
                  lines = lines.concat(PdfDiffCore.itemsToLines(tc.items, p, vp));
                  if (onProgress) onProgress(p, doc.numPages);
                });
              });
          })(p);
        }
        return chain.then(function () { return { lines: lines, pages: doc.numPages, buf: buf }; });
      });
    });
  }

  function loadFile(slot, file) {
    var s = state[slot];
    var drop = $('drop' + slot);
    s.file = file; s.raw = null; s.buf = null; state.marks = null;
    $('dl').hidden = true;
    $('name' + slot).textContent = file.name;
    $('meta' + slot).textContent = '讀取中…';
    drop.classList.add('filled');
    updateGo();
    return extractPdf(file, function (p, n) {
      $('meta' + slot).textContent = '讀取中… ' + p + ' / ' + n + ' 頁';
    }).then(function (r) {
      if (state[slot].file !== file) return;
      s.raw = r.lines; s.pages = r.pages; s.buf = r.buf;
      var chars = r.lines.reduce(function (n, l) { return n + l.text.length; }, 0);
      $('meta' + slot).textContent = r.pages + ' 頁 · ' + r.lines.length + ' 行文字';
      if (chars < 20) {
        setStatus('「' + file.name + '」幾乎沒有可擷取的文字，可能是掃描檔（圖片），無法用文字比對。', 'warn');
      } else if (!$('status').classList.contains('err')) {
        setStatus('');
      }
      updateGo();
    }).catch(function (e) {
      if (state[slot].file !== file) return;
      s.file = null; s.raw = null; s.buf = null;
      drop.classList.remove('filled');
      $('name' + slot).textContent = '拖曳 PDF 到這裡，或點擊選擇';
      $('meta' + slot).textContent = '';
      setStatus('無法讀取「' + file.name + '」：' + (e && e.message ? e.message : e), 'err');
      updateGo();
    });
  }

  function updateGo() {
    $('go').disabled = !(state.A.raw && state.B.raw);
  }

  function opts() {
    return { ignoreCase: $('optCase').checked, ignoreSpaces: $('optSpace').checked, dropHdr: $('optHdr').checked };
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function cell(side, kind) {
    var c = el('div', 'cell ' + kind);
    var no = el('div', 'no');
    var txt = el('div', 'txt');
    if (side) {
      no.appendChild(document.createTextNode(String(side.no)));
      var pg = el('small', null, 'p' + side.page);
      no.appendChild(pg);
      side.parts.forEach(function (p) {
        if (p.t === 'same') txt.appendChild(document.createTextNode(p.text));
        else txt.appendChild(el('span', p.t === 'del' ? 'del-mark' : 'add-mark', p.text));
      });
    } else {
      c.classList.add('empty');
    }
    c.appendChild(no); c.appendChild(txt);
    return c;
  }

  function rowEl(r) {
    var row = el('div', 'row ' + r.type);
    var kl = r.type === 'del' ? 'del' : r.type === 'mod' ? 'mod' : '';
    var kr = r.type === 'add' ? 'add' : r.type === 'mod' ? 'mod' : '';
    row.appendChild(cell(r.a, kl));
    row.appendChild(cell(r.b, kr));
    return row;
  }

  function render(result) {
    var rows = result.rows, st = result.stats;
    var box = $('diff');
    box.textContent = '';
    blocks = []; cur = -1;

    $('stats').innerHTML = '';
    function stat(cls, label, n) {
      var s = el('span');
      var d = el('i', 'dot ' + cls); s.appendChild(d);
      s.appendChild(document.createTextNode(label + ' '));
      s.appendChild(el('b', null, String(n)));
      $('stats').appendChild(s);
    }
    stat('mod', '修改', st.mod);
    stat('del', '刪除', st.del);
    stat('add', '新增', st.add);
    $('stats').appendChild(el('span', null, '共 ' + st.blocks + ' 處差異區塊'));

    if (st.blocks === 0) {
      box.appendChild(el('div', 'same-all', '兩份 PDF 的文字內容相同'));
      $('pos').textContent = '0 / 0';
      return;
    }

    var ctx = $('optView').value === 'context' ? 3 : Infinity;
    var show = new Array(rows.length);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].type !== 'same') {
        for (var k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) show[k] = true;
        if (ctx === Infinity) break;
      }
    }
    if (ctx === Infinity) show.fill(true);

    var frag = document.createDocumentFragment();
    var prevDiff = false;
    for (var j = 0; j < rows.length; j++) {
      if (show[j]) {
        var re = rowEl(rows[j]);
        var isDiff = rows[j].type !== 'same';
        if (isDiff && !prevDiff) blocks.push(re);
        prevDiff = isDiff;
        frag.appendChild(re);
      } else {
        var start = j;
        while (j < rows.length && !show[j]) j++;
        var n = j - start; j--;
        frag.appendChild(foldEl(rows, start, j, n));
        prevDiff = false;
      }
    }
    box.appendChild(frag);
    $('pos').textContent = '0 / ' + blocks.length;
  }

  function foldEl(rows, start, end, n) {
    var g = el('div', 'gap', '⋯ 省略 ' + n + ' 行相同內容（點擊展開）');
    g.style.cursor = 'pointer';
    g.addEventListener('click', function () {
      var f = document.createDocumentFragment();
      for (var i = start; i <= end; i++) f.appendChild(rowEl(rows[i]));
      g.replaceWith(f);
    });
    return g;
  }

  function go(delta) {
    if (!blocks.length) return;
    if (cur >= 0) blocks[cur].classList.remove('cur');
    cur = cur < 0 ? (delta > 0 ? 0 : blocks.length - 1) : (cur + delta + blocks.length) % blocks.length;
    var b = blocks[cur];
    b.classList.add('cur');
    b.scrollIntoView({ block: 'center', behavior: 'smooth' });
    $('pos').textContent = (cur + 1) + ' / ' + blocks.length;
  }

  function compare() {
    if (!(state.A.raw && state.B.raw)) return;
    setStatus('比對中…');
    // let the browser paint the status text first
    setTimeout(function () {
      try {
        var t0 = performance.now();
        var o = opts();
        var none = function (raw) { return { lines: raw, dropped: 0 }; };
        var A = o.dropHdr ? PdfDiffCore.dropRepeatedHeaders(state.A.raw, state.A.pages) : none(state.A.raw);
        var B = o.dropHdr ? PdfDiffCore.dropRepeatedHeaders(state.B.raw, state.B.pages) : none(state.B.raw);
        var result = PdfDiffCore.computeDiff(A.lines, B.lines, o);
        state.marks = PdfDiffCore.collectMarks(result.rows, A.lines, B.lines);
        $('result').hidden = false;
        render(result);
        showDownloads();
        hasResult = true;
        var note = o.dropHdr ? '（已略過每頁重複的頁首/頁尾：原始 ' + A.dropped + ' 行、修訂後 ' + B.dropped + ' 行）' : '';
        setStatus('完成，耗時 ' + Math.round(performance.now() - t0) + ' ms。' + note);
      } catch (e) {
        setStatus('比對失敗：' + (e && e.message ? e.message : e), 'err');
      }
    }, 20);
  }

  function pick(slot, files) {
    var f = files && files[0];
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') {
      setStatus('「' + f.name + '」不是 PDF 檔。', 'err');
      return;
    }
    setStatus('');
    loadFile(slot, f).then(function () { if (hasResult && state.A.raw && state.B.raw) compare(); });
  }

  ['A', 'B'].forEach(function (slot) {
    var drop = $('drop' + slot);
    $('file' + slot).addEventListener('change', function (e) { pick(slot, e.target.files); e.target.value = ''; });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      var files = Array.prototype.slice.call(e.dataTransfer.files || []);
      if (files.length >= 2) {            // two files dropped at once: first -> A, second -> B
        pick('A', [files[0]]); pick('B', [files[1]]);
      } else {
        pick(slot, files);
      }
    });
  });

  $('swap').addEventListener('click', function () {
    var t = state.A; state.A = state.B; state.B = t;
    ['A', 'B'].forEach(function (s) {
      var f = state[s].file;
      $('name' + s).textContent = f ? f.name : '拖曳 PDF 到這裡，或點擊選擇';
      $('drop' + s).classList.toggle('filled', !!f);
    });
    var ma = $('metaA').textContent; $('metaA').textContent = $('metaB').textContent; $('metaB').textContent = ma;
    if (hasResult) compare();
  });

  $('go').addEventListener('click', compare);
  ['optCase', 'optSpace', 'optView', 'optHdr'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (hasResult) compare(); });
  });
  function showDownloads() {
    var m = state.marks;
    $('dl').hidden = false;
    $('dlA').textContent = '下載修訂前（已劃記，' + m.countA + ' 處）';
    $('dlB').textContent = '下載修訂後（已劃記，' + m.countB + ' 處）';
    $('dlA').disabled = $('dlB').disabled = false;
  }

  function baseName(f) { return f.name.replace(/\.pdf$/i, ''); }

  function download(slot) {
    var s = state[slot], isA = slot === 'A';
    var btn = $('dl' + slot);
    if (!s.buf || !state.marks) return;
    btn.disabled = true;
    setStatus('正在產生' + (isA ? '修訂前' : '修訂後') + '已劃記的 PDF…');
    PdfMarker.markPdf(s.buf, isA ? state.marks.a : state.marks.b, {
      color: isA ? [1, 0.6, 0.6] : [0.6, 0.95, 0.6],
      removeHighlights: $('optStrip').checked
    }).then(function (r) {
      var url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
      var a = document.createElement('a');
      a.href = url;
      a.download = baseName(s.file) + (isA ? '_修訂前_已劃記.pdf' : '_修訂後_已劃記.pdf');
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      setStatus('已產生「' + a.download + '」：標示 ' + r.drawn + ' 處' +
        (r.removed ? '，並移除原檔 ' + r.removed + ' 個螢光標示' : '') + '。');
    }).catch(function (e) {
      setStatus('產生 PDF 失敗：' + (e && e.message ? e.message : e), 'err');
    }).then(function () { btn.disabled = false; });
  }
  $('dlA').addEventListener('click', function () { download('A'); });
  $('dlB').addEventListener('click', function () { download('B'); });

  $('next').addEventListener('click', function () { go(1); });
  $('prev').addEventListener('click', function () { go(-1); });
  document.addEventListener('keydown', function (e) {
    if (e.target.closest && e.target.closest('input,select,textarea')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'n') go(1); else if (e.key === 'p') go(-1);
  });
})();

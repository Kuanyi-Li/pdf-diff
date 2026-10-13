/* Draws highlight rectangles onto a PDF (pdf-lib). Browser: PdfMarker, Node: require('./marker.js'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('pdf-lib'));
  else root.PdfMarker = factory(root.PDFLib);
})(typeof self !== 'undefined' ? self : this, function (PDFLib) {
  'use strict';

  /** Remove /Highlight annotations (and their popups) from one page. Returns number removed. */
  function stripHighlights(doc, page) {
    var annots = page.node.Annots();
    if (!annots) return 0;
    var removedRefs = [], n = 0, i, dict;
    for (i = annots.size() - 1; i >= 0; i--) {
      var ref = annots.get(i);
      dict = doc.context.lookup(ref);
      if (!dict || !dict.get) continue;
      var st = dict.get(PDFLib.PDFName.of('Subtype'));
      if (st === PDFLib.PDFName.of('Highlight')) { removedRefs.push(String(ref)); annots.remove(i); n++; }
    }
    if (n) {
      for (i = annots.size() - 1; i >= 0; i--) {
        dict = doc.context.lookup(annots.get(i));
        if (!dict || !dict.get) continue;
        if (dict.get(PDFLib.PDFName.of('Subtype')) === PDFLib.PDFName.of('Popup')) {
          var parent = dict.get(PDFLib.PDFName.of('Parent'));
          if (parent && removedRefs.indexOf(String(parent)) !== -1) annots.remove(i);
        }
      }
    }
    return n;
  }

  /**
   * bytes: ArrayBuffer/Uint8Array of the original PDF.
   * marks: {pageNumber(1-based): [{x0,y0,x1,y1}]}
   * opts: {color:[r,g,b] (0..1), removeHighlights:boolean}
   */
  function markPdf(bytes, marks, opts) {
    opts = opts || {};
    var color = opts.color || [1, 0.55, 0.55];
    return PDFLib.PDFDocument.load(bytes, { updateMetadata: false }).then(function (doc) {
      var pages = doc.getPages(), removed = 0, drawn = 0;
      pages.forEach(function (page, i) {
        if (opts.removeHighlights) removed += stripHighlights(doc, page);
        var list = marks[i + 1];
        if (!list) return;
        list.forEach(function (r) {
          page.drawRectangle({
            x: r.x0 - 0.5, y: r.y0, width: (r.x1 - r.x0) + 1, height: r.y1 - r.y0,
            color: PDFLib.rgb(color[0], color[1], color[2]),
            blendMode: PDFLib.BlendMode.Multiply
          });
          drawn++;
        });
      });
      return doc.save({ useObjectStreams: true }).then(function (out) {
        return { bytes: out, drawn: drawn, removed: removed };
      });
    });
  }

  return { markPdf: markPdf };
});

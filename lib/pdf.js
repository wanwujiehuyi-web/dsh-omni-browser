// dsh-omni-browser / lib/pdf.js
// Print a page to PDF through Page.printToPDF.
// Zero dependencies: only node:* builtins and lib/util.js helpers.
import path from 'node:path';
import { writeBinary, ensureDir, makeOutputDir, resolveDir, fileSize } from './util.js';

const PAPER = {
  a4: { width: 8.27, height: 11.69 },
  letter: { width: 8.5, height: 11 },
  legal: { width: 8.5, height: 14 },
  a3: { width: 11.69, height: 16.54 },
  a5: { width: 5.83, height: 8.27 },
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Best-effort page counter: counts /Type /Page objects in the PDF body. */
function countPdfPages(buf) {
  try {
    const text = buf.toString('latin1');
    const direct = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g);
    if (direct && direct.length > 0) return direct.length;
    // Fall back to counting page-tree /Count entries (the largest one).
    let max = 0;
    const re = /\/Count\s+(\d+)/g;
    let m;
    while ((m = re.exec(text))) max = Math.max(max, Number(m[1]) || 0);
    return max > 0 ? max : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Print the current page to PDF.
 * Options are passed through to Page.printToPDF; headerTemplate/footerTemplate are
 * forwarded verbatim and imply displayHeaderFooter when set.
 * returns {path, bytes, pageCount?}
 */
export async function printToPdf(page, opts = {}) {
  if (!page || typeof page.send !== 'function') throw new Error('printToPdf: a PageHandle is required');
  const paper = String(opts.paper || opts.paperSize || '').toLowerCase();
  const preset = PAPER[paper] || null;
  const paperWidth = num(opts.paperWidth, preset ? preset.width : 8.27);
  const paperHeight = num(opts.paperHeight, preset ? preset.height : 11.69);
  const displayHeaderFooter =
    opts.displayHeaderFooter !== undefined ? Boolean(opts.displayHeaderFooter) : Boolean(opts.headerTemplate || opts.footerTemplate);
  const timeout = num(opts.timeout, 60000);
  const filename = opts.filename ? String(opts.filename) : `page-${Date.now()}.pdf`;

  const dir = opts.dir ? path.resolve(resolveDir(opts.dir) || opts.dir) : makeOutputDir({ name: 'pdf' });
  await ensureDir(dir);
  const file = path.isAbsolute(filename) ? filename : path.join(dir, path.extname(filename) ? filename : `${filename}.pdf`);

  const params = {
    landscape: Boolean(opts.landscape),
    printBackground: opts.printBackground !== false,
    scale: Math.max(0.1, Math.min(2, num(opts.scale, 1))),
    paperWidth: Math.max(0.1, paperWidth),
    paperHeight: Math.max(0.1, paperHeight),
    marginTop: num(opts.marginTop, 0.4),
    marginBottom: num(opts.marginBottom, 0.4),
    marginLeft: num(opts.marginLeft, 0.4),
    marginRight: num(opts.marginRight, 0.4),
    displayHeaderFooter,
    preferCSSPageSize: Boolean(opts.preferCSSPageSize),
  };
  if (opts.pageRanges) params.pageRanges = String(opts.pageRanges);
  if (opts.headerTemplate) params.headerTemplate = String(opts.headerTemplate);
  if (opts.footerTemplate) params.footerTemplate = String(opts.footerTemplate);
  if (opts.transferMode) params.transferMode = String(opts.transferMode);

  try {
    await page.enableDomains({ page: true });
    const result = await page.send('Page.printToPDF', params, { timeout });
    let buf;
    if (result.data) {
      buf = Buffer.from(result.data, 'base64');
    } else if (opts.transferMode === 'ReturnAsStream' && result.stream) {
      const chunks = [];
      let eof = false;
      while (!eof) {
        const part = await page.send('IO.read', { handle: result.stream, size: 1024 * 1024 }, { timeout });
        if (part.base64Encoded) chunks.push(Buffer.from(part.data || '', 'base64'));
        else chunks.push(Buffer.from(part.data || '', 'utf8'));
        eof = Boolean(part.eof);
      }
      await page.send('IO.close', { handle: result.stream }).catch(() => {});
      buf = Buffer.concat(chunks);
    } else {
      throw new Error('Page.printToPDF returned no data');
    }
    if (!buf.length) throw new Error('Page.printToPDF returned an empty PDF');
    await writeBinary(file, buf);
    const out = { path: file, bytes: buf.length };
    const pageCount = countPdfPages(buf);
    if (pageCount) out.pageCount = pageCount;
    if (!buf.subarray(0, 5).toString('latin1').startsWith('%PDF-')) out.warning = 'output does not start with %PDF-';
    return out;
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`printToPdf failed: ${detail}`);
  }
}

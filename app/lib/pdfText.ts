// Pulls the text out of a PDF in the browser, as rows of cells laid out the way
// they appear on the page. Nothing is uploaded to read it.

/** Gap (in PDF units) between two pieces of text that starts a new cell. */
const CELL_GAP = 14;
/** Pieces within this vertical distance are on the same row. */
const ROW_TOLERANCE = 3;

interface Piece { x: number; y: number; w: number; str: string }

export async function pdfRows(file: Blob): Promise<string[][]> {
  // Paystubs are one or two pages; the first few cover every layout we've seen.
  return (await pdfPageRows(file, 4)).flat();
}

/** The rows of each page, one list per page (up to `maxPages`). */
export async function pdfPageRows(file: Blob, maxPages = Infinity): Promise<string[][][]> {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  // A paystub never needs scripts or fonts compiled to code: keep pdf.js from evaluating anything.
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, enableXfa: false,
  }).promise;
  const pages: string[][][] = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pieces: Piece[] = [];
    for (const item of content.items as any[]) {
      if (!item.str || !item.str.trim()) continue;
      pieces.push({ x: item.transform[4], y: item.transform[5], w: item.width ?? 0, str: item.str });
    }
    pages.push(toRows(pieces));
  }
  await doc.destroy();
  return pages;
}

export function toRows(pieces: Piece[]): string[][] {
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Piece[][] = [];
  for (const p of sorted) {
    const line = lines.find((l) => Math.abs(l[0].y - p.y) <= ROW_TOLERANCE);
    if (line) line.push(p);
    else lines.push([p]);
  }
  return lines.map((line) => {
    line.sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let end = -Infinity;
    for (const p of line) {
      if (cells.length === 0 || p.x - end > CELL_GAP) cells.push(p.str);
      else cells[cells.length - 1] += (p.x - end > 1 ? " " : "") + p.str;
      end = p.x + p.w;
    }
    return cells.map((c) => c.replace(/\s+/g, " ").trim()).filter(Boolean);
  });
}

/** Base64 of a file, for sending to the server's fallback reader. */
export function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// Splits a PDF into one PDF per page, so a single file holding a year of
// paystubs (one per page) can be saved as one paystub per page.

/** Most pages split out of one PDF (a year of weekly paystubs, with room to spare). */
export const MAX_PDF_PAGES = 200;
/** Largest PDF to split. */
export const MAX_PDF_BYTES = 100 << 20;

export async function splitPdfPages(bytes: Uint8Array): Promise<Uint8Array[]> {
  if (bytes.length > MAX_PDF_BYTES) throw new Error(`That PDF is more than ${MAX_PDF_BYTES >> 20} MB. Split it into smaller files.`);
  const { PDFDocument } = await import("pdf-lib");
  let source;
  try {
    source = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new Error("That PDF couldn't be opened. It may be damaged.");
  }
  if (source.getPageCount() > MAX_PDF_PAGES) {
    throw new Error(`That PDF has ${source.getPageCount()} pages; the most at once is ${MAX_PDF_PAGES}. Split it into smaller files.`);
  }
  const out: Uint8Array[] = [];
  for (let i = 0; i < source.getPageCount(); i++) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(source, [i]);
    doc.addPage(page);
    out.push(await doc.save());
  }
  return out;
}

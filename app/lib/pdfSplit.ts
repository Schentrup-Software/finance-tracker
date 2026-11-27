// Splits a PDF into one PDF per page, so a single file holding a year of
// paystubs (one per page) can be saved as one paystub per page.

export async function splitPdfPages(bytes: Uint8Array): Promise<Uint8Array[]> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const out: Uint8Array[] = [];
  for (let i = 0; i < source.getPageCount(); i++) {
    const doc = await PDFDocument.create();
    const [page] = await doc.copyPages(source, [i]);
    doc.addPage(page);
    out.push(await doc.save());
  }
  return out;
}

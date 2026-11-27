import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { MAX_PDF_PAGES, splitPdfPages } from "~/lib/pdfSplit";

describe("splitting a PDF into pages", () => {
  it("makes one single-page PDF per page, in order", async () => {
    const doc = await PDFDocument.create();
    for (const w of [300, 400, 500]) doc.addPage([w, 600]);
    const pages = await splitPdfPages(await doc.save());
    expect(pages).toHaveLength(3);
    for (const [i, bytes] of pages.entries()) {
      const one = await PDFDocument.load(bytes);
      expect(one.getPageCount()).toBe(1);
      expect(one.getPage(0).getWidth()).toBe([300, 400, 500][i]);
    }
  });

  it("refuses a PDF with too many pages, or one that isn't a PDF", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i <= MAX_PDF_PAGES; i++) doc.addPage([100, 100]);
    await expect(splitPdfPages(await doc.save())).rejects.toThrow(`the most at once is ${MAX_PDF_PAGES}`);
    await expect(splitPdfPages(new TextEncoder().encode("not a pdf"))).rejects.toThrow("couldn't be opened");
  });
});

import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { splitPdfPages } from "~/lib/pdfSplit";

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
});

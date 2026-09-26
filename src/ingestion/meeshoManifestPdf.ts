/**
 * Meesho "Supplier Manifest" PDF parser — added by Claude (Anthropic)
 * 2026-09-26, user request (Hinglish): "MEESHO SE YE FILE AATI HAI TRACKING
 * KE LIYE PDF ME TO ISKO KESE KARENGE" (Meesho sends this file for tracking,
 * in PDF format — how do we handle it).
 *
 * The manifest is a multi-page PDF: page 1 is a "Picklist" (SKU/Color/Size
 * summary, no order-level identifiers, no AWB) — skipped entirely. Every
 * page after that is headed "Courier : <name>" (one page per courier
 * partner used in that dispatch batch, e.g. "Courier : Valmo", "Courier :
 * Delhivery" — a single manifest can carry more than one), each holding a
 * table: S. No. / Sub Order No. / AWB / SKU / Qty. / Size / Packed.
 *
 * The one real parsing quirk: "Sub Order No." is wrapped across two lines
 * in the extracted text because of the table's narrow column width, e.g.
 * raw extraction "33496320768\n1783104_1" is really the single token
 * "334963207681783104_1" — concatenated with NO separator, which then
 * follows Meesho's normal `<order id>_<line seq>` convention (see
 * orderIdFromSubOrder() in src/routes/orders.ts). This file only
 * reconstructs that token; it deliberately does NOT re-derive the order id
 * itself, since /orders/awb-import already knows how to strip the `_<line
 * seq>` suffix for both CSV and PDF rows alike.
 *
 * Verified 2026-09-26 against 4 real Meesho manifest PDFs (Vardhamiti,
 * Arvagam x2, KANJUSH — the KANJUSH one spans a Delhivery page AND a Valmo
 * page in the same file) using pdf-parse's per-page text extraction --
 * this regex is deliberately narrow (row number, then a bare digit run
 * immediately followed by a newline, then the `_<seq>` continuation) so it
 * can't accidentally match text inside a wrapped SKU/product-name line,
 * which is free text and never has that exact shape.
 */
import { PDFParse } from "pdf-parse";

export interface ManifestPdfRow {
  subOrderNo: string;
  awb: string;
  carrier: string;
  page: number;
}

const COURIER_HEADER_RE = /^Courier\s*:\s*(.+)$/m;
// Row shape: "<s.no> <subOrderPart1>\n<subOrderPart2_lineSeq> <awbToken> ..."
// -- deliberately stops right after the AWB token; SKU/Qty/Size that follow
// (possibly wrapped across more lines themselves) are irrelevant here and
// never risk matching this pattern since they don't end in "\n<digits>".
const ROW_RE = /(\d+)\s+(\d+)\s*\n(\d+_\d+)\s+(\S+)/g;

/**
 * Parses every courier-partner page of a Meesho Supplier Manifest PDF into
 * {subOrderNo, awb, carrier} rows. The "Picklist" page (and any other page
 * without a "Courier : ..." header) is skipped -- it carries no AWB data.
 * Returns an empty array (never throws) for a PDF that doesn't match this
 * shape at all, so the caller can report a clear "couldn't find any AWB
 * rows in this PDF" rather than a raw parser exception.
 */
export async function parseMeeshoManifestPdf(pdfBuffer: Buffer): Promise<ManifestPdfRow[]> {
  const parser = new PDFParse({ data: pdfBuffer });
  try {
    let result;
    try {
      result = await parser.getText();
    } catch (e) {
      // A non-PDF or corrupted upload throws deep inside pdf-parse/pdf.js
      // (e.g. InvalidPDFException) -- caught here so the route can turn it
      // into a normal 400 instead of a raw 500, same "never a hard crash on
      // bad input" standard as the CSV importers' own try/catch-per-row.
      throw new Error(`Couldn't read this file as a PDF (${e instanceof Error ? e.message : String(e)})`);
    }
    const rows: ManifestPdfRow[] = [];

    result.pages.forEach((p, idx) => {
      const courierMatch = COURIER_HEADER_RE.exec(p.text);
      if (!courierMatch) return; // Picklist page or unrecognized page shape
      const carrier = courierMatch[1].trim();

      let m: RegExpExecArray | null;
      ROW_RE.lastIndex = 0;
      while ((m = ROW_RE.exec(p.text)) !== null) {
        const subOrderNo = `${m[2]}${m[3]}`;
        rows.push({ subOrderNo, awb: m[4], carrier, page: idx + 1 });
      }
    });

    return rows;
  } finally {
    await parser.destroy();
  }
}

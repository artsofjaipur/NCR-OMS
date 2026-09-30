import { parseCsv } from "../csv";

/**
 * Parser for the "MASTER STOCK SHEET" family of party Stock-In sheets
 * (APL, Shivam, AK Enterprises, JK, and whatever future party sheet follows
 * the same shape) — added 2026-09-25 per user request to turn these into
 * real, editable Stock-In ledger entries instead of a one-time data load.
 *
 * The four real files this was built against do NOT share one column set:
 *   APL:           Date,SKU,Product Name,Quantity In,In Date,Rate / Qty,Total Amt.,5% GST,To Be Paid,Total To be paid Balance,Chalan no.,Remark,Paid Date,Balance Dues
 *   Shivam:        ...,Party Chalan no.,our Chalan no.,Bill.no.,Bill Date,To be Pay Amt.,Paid Date,Remark
 *   AK Enterprises:...,Party Chalan no.,Our Chalan no.,Bill.no.,Bill Date,To be Pay ,Paid Date,REMARK
 *   JK:            ...,Remark,Paid Date,Paid   (here "Paid" is a NUMBER — amount actually paid — not a status word)
 * so this parses by normalized header name lookup (case/space/punctuation
 * insensitive) rather than fixed column positions, and every derived money
 * figure (subtotal/GST/payable) is recomputed from qty*rate rather than
 * trusted from the sheet — the sheet's own "Total Amt./GST/To Be Paid/
 * Total To be paid Balance/Balance Dues" columns are running-total/helper
 * columns that break the moment a row is edited or deleted, exactly the
 * kind of silently-stale number this feature exists to replace with a
 * live, always-correct calculation (see modules/purchases/purchases.ts).
 */

export interface StockInRow {
  rowIndex: number; // 1-based data-row index, for error messages
  skuCodeRaw: string | null;
  productName: string | null;
  quantity: number;
  rate: number;
  entryDate: Date | null;
  entryDateRaw: string | null;
  partyChalanNo: string | null;
  ourChalanNo: string | null;
  supplierInvoiceNumber: string | null;
  invoiceDate: Date | null;
  paidDate: Date | null;
  paidAmount: number | null; // explicit paid amount when the sheet gives one (e.g. JK's "Paid" column)
  paidFlagText: string | null; // e.g. "PAID" seen in a Remark-style column
  remark: string | null;
}

export interface StockInParseResult {
  rows: StockInRow[];
  skippedRowCount: number; // blank/spacer/trailer rows, not an error
  warnings: string[];
}

function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADER_ALIASES: Record<string, string[]> = {
  sku: ["sku"],
  productName: ["product name", "productname"],
  quantity: ["quantity in", "qty"],
  inDate: ["in date", "indate"],
  rate: ["rate / qty", "rate/ qty", "rate /qty", "rate", "rate per qty"],
  partyChalanNo: ["party chalan no", "chalan no"],
  ourChalanNo: ["our chalan no"],
  billNo: ["bill no", "billno"],
  billDate: ["bill date"],
  paidDate: ["paid date"],
  remark: ["remark"],
  paid: ["paid"], // JK-only: a numeric "amount actually paid" column, distinct from "remark"
};

function findColumn(headerRow: string[], keys: string[]): number {
  const normalized = headerRow.map(normalizeHeader);
  for (const key of keys) {
    const idx = normalized.indexOf(key);
    if (idx !== -1) return idx;
  }
  return -1;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Handles every date shape seen across the four real files: "1 Apr2026"
 * (month+year glued, no space), "24 Jan2026", "11 Feb" / "02 March" (no
 * year at all), "6-May" / "08-April-2026" (dash-separated, year optional).
 * Rows lacking an explicit year reuse the most recent explicit year seen
 * while scanning top-to-bottom (the sheets are roughly chronological) —
 * safer than hardcoding one year, since JK's history spans Dec 2025 into
 * 2026 and a hardcoded year would silently mis-date the Dec 2025 rows.
 */
export function parseFlexibleDate(raw: string, yearState: { value: number }): Date | null {
  // "12June" / "29May" (day and month glued with no space or dash, seen in
  // the real AK Enterprises sheet) — insert the missing space before
  // splitting, same as the day/month separator every other row already has.
  const trimmed = (raw || "").trim().replace(/^(\d+)([A-Za-z])/, "$1 $2");
  if (!trimmed) return null;

  const parts = trimmed.split(/[\s-]+/).filter(Boolean);
  if (parts.length < 2) return null;

  const day = parseInt(parts[0], 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  // Second token may be "Apr2026" (glued) or "Apr" / "April".
  const monthToken = parts[1];
  const monthMatch = monthToken.match(/^([a-zA-Z]+)(\d{2,4})?$/);
  if (!monthMatch) return null;
  const monthName = monthMatch[1].toLowerCase();
  const month = MONTHS[monthName];
  if (month === undefined) return null;

  let year: number | null = null;
  if (monthMatch[2]) {
    year = Number(monthMatch[2].length === 2 ? "20" + monthMatch[2] : monthMatch[2]);
  } else if (parts[2] && /^\d{2,4}$/.test(parts[2])) {
    year = Number(parts[2].length === 2 ? "20" + parts[2] : parts[2]);
  }

  if (year != null) {
    yearState.value = year;
  } else {
    year = yearState.value;
  }

  const d = new Date(Date.UTC(year, month, day));
  return isNaN(d.getTime()) ? null : d;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[₹,\s]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseStockInCsv(text: string): StockInParseResult {
  const rows = parseCsv(text);
  const warnings: string[] = [];
  if (rows.length === 0) return { rows: [], skippedRowCount: 0, warnings: ["File is empty"] };

  const header = rows[0];
  const col = {
    sku: findColumn(header, HEADER_ALIASES.sku),
    productName: findColumn(header, HEADER_ALIASES.productName),
    quantity: findColumn(header, HEADER_ALIASES.quantity),
    inDate: findColumn(header, HEADER_ALIASES.inDate),
    rate: findColumn(header, HEADER_ALIASES.rate),
    partyChalanNo: findColumn(header, HEADER_ALIASES.partyChalanNo),
    ourChalanNo: findColumn(header, HEADER_ALIASES.ourChalanNo),
    billNo: findColumn(header, HEADER_ALIASES.billNo),
    billDate: findColumn(header, HEADER_ALIASES.billDate),
    paidDate: findColumn(header, HEADER_ALIASES.paidDate),
    remark: findColumn(header, HEADER_ALIASES.remark),
    paid: findColumn(header, HEADER_ALIASES.paid),
  };

  if (col.quantity === -1) {
    warnings.push('Could not find a "Quantity In" column — is this a Stock-In sheet in the expected format?');
    return { rows: [], skippedRowCount: 0, warnings };
  }

  const out: StockInRow[] = [];
  let skipped = 0;
  const yearState = { value: new Date().getUTCFullYear() };
  let dataRowIndex = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const get = (idx: number) => (idx === -1 ? "" : (r[idx] ?? "").trim());

    const skuRaw = get(col.sku);
    const productName = get(col.productName);
    const qty = parseNumber(get(col.quantity));

    // Spacer / running-balance-only / trailer ("TOTAL STOCK IN") rows carry
    // no SKU, no product name and no quantity — not real entries, skip
    // quietly (this is the normal case for most rows in these sheets).
    if (!skuRaw && !productName && !qty) {
      continue;
    }
    if (!qty || qty <= 0) {
      // Has a SKU/product but no usable quantity — real anomaly, flag it.
      warnings.push(`Row ${i + 1}: has SKU/product but no usable quantity — skipped`);
      skipped++;
      continue;
    }

    dataRowIndex++;
    const rate = parseNumber(get(col.rate)) ?? 0;
    const paidAmount = col.paid !== -1 ? parseNumber(get(col.paid)) : null;
    const remark = get(col.remark) || null;

    // "Paid Date" sometimes carries a status word instead of a date (real
    // example, AK Enterprises: "PAID" / "PANDING" / "PAIDING" typed straight
    // into that column, Remark left blank) — when it fails to parse as a
    // date, don't silently drop that text: fold it into the paid-flag
    // signal alongside Remark, so "PAID" here still marks the bill paid.
    const paidDateRaw = get(col.paidDate);
    const paidDate = parseFlexibleDate(paidDateRaw, yearState);
    const paidFlagText = [remark, !paidDate ? paidDateRaw : null].filter(Boolean).join(" ") || null;

    out.push({
      rowIndex: dataRowIndex,
      skuCodeRaw: skuRaw || null,
      productName: productName || null,
      quantity: qty,
      rate,
      entryDateRaw: get(col.inDate) || null,
      entryDate: parseFlexibleDate(get(col.inDate), yearState),
      partyChalanNo: get(col.partyChalanNo) || null,
      ourChalanNo: get(col.ourChalanNo) || null,
      supplierInvoiceNumber: get(col.billNo) || null,
      invoiceDate: parseFlexibleDate(get(col.billDate), yearState),
      paidDate,
      paidAmount,
      paidFlagText,
      remark,
    });
  }

  return { rows: out, skippedRowCount: skipped, warnings };
}

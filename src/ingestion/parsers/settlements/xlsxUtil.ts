import * as XLSX from "xlsx";

export type SheetRow = Record<string, unknown>;

/**
 * Every marketplace settlement sheet we've seen puts a merged "section
 * title" row above the real column-header row (e.g. Flipkart's Orders tab:
 * row 1 = "Payment Details" / "Transaction Summary" / ... spanning a handful
 * of merged cells, row 2 = the ~70 actual column names). A few sheets
 * (Snapdeal's) have no title row at all — the header is already row 1.
 *
 * Rather than hardcode a header-row index per sheet (which breaks the
 * moment a marketplace adds/removes a title row), detect it. The first
 * attempt — "whichever of the first 6 rows has the most non-empty cells" —
 * turned out wrong on real data: Flipkart's Orders tab has blank spacer
 * columns *between* its column-group headers, so its header row (63
 * populated cells) has FEWER non-empty cells than the very first DATA row
 * beneath it (67 populated cells, since real order rows rarely have gaps).
 * The reliable signal instead is that header cells are always text while a
 * data row is a mix of text/numbers/dates: score each candidate row by how
 * many of its non-empty cells are STRING-typed, not by raw cell count.
 * Verified against every tab in the six real files (Flipkart, Meesho,
 * Snapdeal) this was built against — including the exact Orders-tab case
 * above — before relying on it.
 */
function detectHeaderRowIndex(grid: unknown[][]): number {
  let best = 0;
  let bestScore = -1;
  const scanRows = Math.min(6, grid.length);
  for (let i = 0; i < scanRows; i++) {
    const row = grid[i] ?? [];
    const nonEmpty = row.filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
    const score = nonEmpty.filter((c) => typeof c === "string").length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

function normalizeHeader(h: unknown): string {
  return String(h ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True for rows that are placeholder/footer noise rather than data:
 * Snapdeal's "Total" footer row, Meesho's "No data is available for these
 * dates." placeholder row on empty sheets, a fully-blank row, or — this is
 * the one that isn't obvious from a label — a formula/column-reference
 * annotation row several sheets insert directly under the header (e.g.
 * Flipkart's Orders row 3: mostly blank except scattered tokens like "G = -
 * (B + C) * F"; Meesho's Order Payments row 3: "Track which orders came
 * from ads" / "A" / formula strings under specific columns). Every real
 * data row observed across all three marketplaces' sheets has its FIRST
 * column populated (Order ID / Sub Order No / NEFT ID / Transaction Date /
 * Reward Id / ...); every annotation/placeholder/footer row observed has it
 * blank — confirmed by inspecting the actual real files this was built
 * against, not assumed. So: blank first cell = noise, full stop.
 */
function isNoiseRow(cells: unknown[]): boolean {
  const nonEmpty = cells.filter((c) => c !== null && c !== undefined && String(c).trim() !== "");
  if (nonEmpty.length === 0) return true;
  const first = String(cells[0] ?? "").trim();
  if (!first) return true;
  const firstLower = first.toLowerCase();
  if (firstLower === "total" || firstLower.startsWith("no data is available")) return true;
  return false;
}

/**
 * Reads one sheet into an array of row objects keyed by its detected header
 * row, skipping noise rows. Column keys are the normalized header text
 * exactly as it appears in the sheet (whitespace-collapsed, trimmed) — use
 * `findKey`/`col` below to look one up by prefix rather than an exact
 * string, since several headers carry embedded formula annotations
 * (e.g. "Bank Settlement Value (Rs.) \n= SUM(J:R)").
 */
export function sheetToRows(ws: XLSX.WorkSheet): SheetRow[] {
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  if (grid.length === 0) return [];
  const headerIdx = detectHeaderRowIndex(grid);
  const rawHeaders = (grid[headerIdx] ?? []).map(normalizeHeader);
  // A few real sheets (Meesho's "Order Payments") reuse the exact same
  // header text for two different columns (e.g. "Fixed Fee (Incl. GST)"
  // appears twice, mapped to different formula components per the sheet's
  // own row-3 annotations). Suffix repeats with " (2)"/" (3)"/... so both
  // survive into the row object instead of the second silently overwriting
  // the first — this keeps `raw` a faithful full-fidelity copy of the sheet.
  const seen = new Map<string, number>();
  const headers = rawHeaders.map((h) => {
    if (!h) return h;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
  const out: SheetRow[] = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const cells = grid[i] ?? [];
    if (isNoiseRow(cells)) continue;
    const obj: SheetRow = {};
    for (let c = 0; c < headers.length; c++) {
      if (!headers[c]) continue;
      obj[headers[c]] = cells[c] ?? null;
    }
    out.push(obj);
  }
  return out;
}

/** Finds a row object's key whose normalized header starts with `prefix` (case-insensitive). First match wins. */
export function findKey(row: SheetRow, prefix: string): string | null {
  const p = prefix.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase().startsWith(p)) return k;
  }
  return null;
}

/** Reads a cell by header prefix, returning null when the column isn't present or the cell is blank. */
export function col(row: SheetRow, prefix: string): unknown {
  const k = findKey(row, prefix);
  if (k === null) return null;
  const v = row[k];
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  return v;
}

/** Reads a cell by header prefix as a trimmed string, or null. */
export function colStr(row: SheetRow, prefix: string): string | null {
  const v = col(row, prefix);
  if (v === null) return null;
  return String(v).trim() || null;
}

/** Reads a cell by header prefix as a number, or 0 when absent/unparseable — settlement amounts default to 0 rather than null so SUM() never breaks on a row. */
export function colNum(row: SheetRow, prefix: string): number {
  const v = col(row, prefix);
  if (v === null) return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** Excel serial-date-aware Date read for a cell already returned as a JS Date by xlsx (cellDates:true), an ISO-ish string, or Snapdeal's text "03-APR-2026" format. Returns null rather than throwing on anything unparseable — one bad cell must never sink the whole import. */
export function colDate(row: SheetRow, prefix: string): Date | null {
  const v = col(row, prefix);
  if (v === null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  const ddMon = parseDDMonYYYY(s);
  if (ddMon) return ddMon;
  const iso = new Date(s);
  if (!Number.isNaN(iso.getTime())) return iso;
  return null;
}

/** "03-APR-2026" style (Snapdeal's settlement sheets) — day, 3-letter month name, 4-digit year. */
const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};
export function parseDDMonYYYY(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value ?? "").trim().toUpperCase();
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{4})$/.exec(s);
  if (!m) return null;
  const [, dd, mon, yyyy] = m;
  const month = MONTHS[mon];
  if (month === undefined) return null;
  const d = new Date(Date.UTC(Number(yyyy), month, Number(dd)));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function loadWorkbook(buffer: Buffer): XLSX.WorkBook {
  // cellDates:true so date-formatted cells arrive as JS Date objects instead
  // of raw Excel serial numbers; bookVBA/cellHTML off — we only ever read
  // values, never macros/formatting, out of an abundance of caution parsing
  // untrusted uploaded files.
  return XLSX.read(buffer, { type: "buffer", cellDates: true, bookVBA: false, cellHTML: false });
}

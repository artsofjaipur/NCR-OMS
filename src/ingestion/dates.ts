/** Each marketplace exports timestamps in its own format — none of them ISO. */

/** Flipkart: "Aug 26, 2026" or "Aug 26, 2026 23:16:23" */
export function parseFlipkartDate(value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable Flipkart date: "${value}"`);
  }
  return d;
}

/** Flipkart invoice date: "mm/dd/yy" */
export function parseFlipkartMMDDYY(value: string): Date {
  const match = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unparseable mm/dd/yy date: "${value}"`);
  }
  const [, mm, dd, yy] = match;
  const year = 2000 + Number(yy);
  return new Date(Date.UTC(year, Number(mm) - 1, Number(dd)));
}

/**
 * Meesho: "2026-08-26" (date only) — the format seen on the "Ready to Ship"
 * export. A different Meesho report ("DOMESTIC ORDER DATA", a fuller order
 * history export) instead carries slash-separated dates, and does so
 * INCONSISTENTLY within a single file (2026-09-25, real export): some rows
 * are zero-padded "01/07/2026" (day/month/year, India's convention), others
 * are un-padded "7/14/2026" (month/day/year, Excel's US-locale default when
 * the column round-trips through a US-formatted spreadsheet). Confirmed by
 * values like "13/07/2026" in the padded rows, which is only valid as
 * dd/mm (there is no 13th month) — so the padding itself is the format
 * signal this file gives us, not something we're guessing blind.
 */
export function parseMeeshoDate(value: string): Date {
  const v = value.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) {
    const [, yyyy, mm, dd] = iso;
    const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
    if (!Number.isNaN(d.getTime())) return d;
  }

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (slash) {
    const [, a, b, yyyy] = slash;
    // Zero-padded both sides => dd/mm/yyyy; otherwise => m/d/yyyy.
    const [dd, mm] = a.length === 2 && b.length === 2 ? [a, b] : [b, a];
    const ddN = Number(dd);
    const mmN = Number(mm);
    if (mmN >= 1 && mmN <= 12 && ddN >= 1 && ddN <= 31) {
      const d = new Date(Date.UTC(Number(yyyy), mmN - 1, ddN));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  throw new Error(`Unparseable Meesho date: "${value}"`);
}

/**
 * Snapdeal date/time. Two real export formats seen across real files
 * (2026-09-25): "HH:mm:ss DD-MM-YYYY" (the original sample) and, in a
 * different/newer "DOMESTIC ORDER DATA" export, "D/M/YYYY H:mm" -- both
 * zero-padded ("11/07/2026 14:54") and un-padded ("5/7/2026 23:42") show up
 * in the SAME file. Confirmed day-first (not month-first) because day
 * values up to 27 appear alongside a second component that never exceeds
 * 12 in that file -- not a guess. That same real file also has a handful of
 * cells where the date's cell FORMATTING was lost upstream and only the
 * raw Excel serial number survived (e.g. "46208.63472", days since
 * 1899-12-30), and a few outright garbage values (a stray "CREATED"
 * literal landing in a date column, likely from a duplicate "MRP" header
 * in that export shifting a value). Returns null rather than throwing for
 * anything this can't make sense of -- a single bad cell in a 5000+ row
 * export must never sink the whole file; see orderedAt's own fallback at
 * the snapdeal.ts call site.
 */
export function parseSnapdealDateTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (slash) {
    const [, dd, mon, yyyy, hh, mm] = slash;
    const monN = Number(mon);
    const ddN = Number(dd);
    if (monN >= 1 && monN <= 12 && ddN >= 1 && ddN <= 31) {
      const d = new Date(Date.UTC(Number(yyyy), monN - 1, ddN, Number(hh), Number(mm)));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const serial = /^\d+(\.\d+)?$/.exec(trimmed);
  if (serial) {
    const n = Number(trimmed);
    if (n > 20000 && n < 60000) {
      // Excel serial epoch (1899-12-30) -> Unix epoch offset, in days.
      const d = new Date(Math.round((n - 25569) * 86400 * 1000));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const match = /^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);
  if (!match) {
    return null;
  }
  const [, hh, mm, ss, dd, mon, yyyy] = match;
  return new Date(Date.UTC(Number(yyyy), Number(mon) - 1, Number(dd), Number(hh), Number(mm), Number(ss)));
}

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

/** Meesho: "2026-08-26" (date only) */
export function parseMeeshoDate(value: string): Date {
  const d = new Date(`${value.trim()}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Unparseable Meesho date: "${value}"`);
  }
  return d;
}

/** Snapdeal: "HH:mm:ss DD-MM-YYYY" */
export function parseSnapdealDateTime(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{2}):(\d{2}):(\d{2})\s+(\d{2})-(\d{2})-(\d{4})$/.exec(trimmed);
  if (!match) {
    throw new Error(`Unparseable Snapdeal date: "${value}"`);
  }
  const [, hh, mm, ss, dd, mon, yyyy] = match;
  return new Date(Date.UTC(Number(yyyy), Number(mon) - 1, Number(dd), Number(hh), Number(mm), Number(ss)));
}

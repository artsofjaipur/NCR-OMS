/**
 * Minimal RFC4180-ish CSV parser: handles quoted fields, commas and
 * newlines inside quotes, and doubled-quote escaping ("" -> "). Good enough
 * for the marketplace exports (Flipkart/Meesho/Snapdeal) without pulling in
 * a dependency for something this small.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const normalized = text.replace(/\r\n/g, "\n");

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  // flush trailing field/row if file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/** Parses a CSV into an array of header-keyed row objects. */
export function parseCsvToRecords(text: string): Record<string, string>[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const [header, ...rest] = rows;
  return rest.map((row) => {
    const record: Record<string, string> = {};
    header.forEach((key, idx) => {
      record[key.trim()] = (row[idx] ?? "").trim();
    });
    return record;
  });
}

/** Coerces the marketplace habit of writing "NA" / "" into a real null. */
export function toNullableNumber(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "NA") return null;
  return trimmed;
}

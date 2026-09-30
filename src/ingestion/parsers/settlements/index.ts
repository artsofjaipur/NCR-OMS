import { loadWorkbook } from "./xlsxUtil";
import { isFlipkartSettlementWorkbook, parseFlipkartSettlementWorkbook } from "./flipkart";
import { isMeeshoSettlementWorkbook, parseMeeshoSettlementWorkbook } from "./meesho";
import { isSnapdealSettlementWorkbook, parseSnapdealSettlementWorkbook } from "./snapdeal";
import { ParsedSettlementWorkbook } from "./types";

export * from "./types";

/**
 * Reads a marketplace payment/settlement .xlsx (any of the three formats
 * seen so far: Flipkart, Meesho, Snapdeal) and normalizes every recognized
 * tab into ParsedSettlementRow[]. Marketplace is auto-detected from the
 * workbook's own sheet names — the user just uploads whatever file they
 * downloaded, no format picker needed.
 */
export function parseSettlementFile(buffer: Buffer): ParsedSettlementWorkbook {
  const wb = loadWorkbook(buffer);
  if (isFlipkartSettlementWorkbook(wb)) return parseFlipkartSettlementWorkbook(wb);
  if (isMeeshoSettlementWorkbook(wb)) return parseMeeshoSettlementWorkbook(wb);
  if (isSnapdealSettlementWorkbook(wb)) return parseSnapdealSettlementWorkbook(wb);
  throw new Error(
    `Sheet tabs (${wb.SheetNames.join(", ")}) don't match a recognized Flipkart, Meesho, or Snapdeal payment-report layout.`
  );
}

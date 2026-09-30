import * as XLSX from "xlsx";
import { ParsedSettlementRow, ParsedSettlementWorkbook } from "./types";
import { sheetToRows, colStr, colNum, colDate } from "./xlsxUtil";

/** True when this workbook is a Snapdeal monthly payment export. */
export function isSnapdealSettlementWorkbook(wb: XLSX.WorkBook): boolean {
  const names = new Set(wb.SheetNames);
  return names.has("Total_Suboders") && names.has("ClosingBalance") && names.has("Payments");
}

/**
 * Snapdeal's "Sub Order No" (e.g. '70704564804') is line-item-level, not
 * order-level — the same fact BRAIN.md already documents for the returns
 * importer's own fallback match (it's Snapdeal's SUBORDERCODE, matched
 * against order_items.marketplaceLineItemId, not orders.marketplaceOrderId).
 * Every order-linked settlement sheet here uses that same "Sub Order No"
 * column, so they all resolve via LINE_ITEM_ID_ONLY.
 */
function orderLink(r: Record<string, unknown>) {
  const subOrderNo = colStr(r, "Sub Order No");
  return { orderItemRaw: subOrderNo, matchStrategy: subOrderNo ? ("LINE_ITEM_ID_ONLY" as const) : null };
}

export function parseSnapdealSettlementWorkbook(wb: XLSX.WorkBook): ParsedSettlementWorkbook {
  const rows: ParsedSettlementRow[] = [];

  const KNOWN_SHEETS = new Set([
    "Help", "Summary", "Total_Suboders", "Returns", "Commission and other charges",
    "Non Order Transactions", "Payments", "ClosingBalance", "TCS",
  ]);
  const unrecognizedSheets = wb.SheetNames.filter((n) => !KNOWN_SHEETS.has(n));

  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  const trackPeriod = (d: Date | null) => {
    if (!d) return;
    if (!periodStart || d < periodStart) periodStart = d;
    if (!periodEnd || d > periodEnd) periodEnd = d;
  };

  // ---- Total_Suboders: the per-line-item invoice record. Informational
  // (taxable/invoice value), not itself a bank-credit line — the actual
  // money movement for these is in Payments/ClosingBalance below.
  if (wb.Sheets["Total_Suboders"]) {
    for (const r of sheetToRows(wb.Sheets["Total_Suboders"])) {
      const { orderItemRaw, matchStrategy } = orderLink(r);
      const occurredAt = colDate(r, "Transaction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "ORDER_PAYMENT",
        marketplaceOrderIdRaw: null,
        orderItemRaw,
        matchStrategy,
        reference: colStr(r, "Invoice Number"),
        occurredAt,
        amount: colNum(r, "Taxable Amount"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  // ---- Returns: reversal of an earlier Total_Suboders line (RTO / customer return). ----
  if (wb.Sheets["Returns"]) {
    for (const r of sheetToRows(wb.Sheets["Returns"])) {
      const { orderItemRaw, matchStrategy } = orderLink(r);
      const occurredAt = colDate(r, "Transaction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "RETURN",
        marketplaceOrderIdRaw: null,
        orderItemRaw,
        matchStrategy,
        reference: colStr(r, "Invoice Number"),
        occurredAt,
        amount: colNum(r, "Taxable Amount"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  // ---- Commission and other charges: per-line-item fee deductions. ----
  if (wb.Sheets["Commission and other charges"]) {
    for (const r of sheetToRows(wb.Sheets["Commission and other charges"])) {
      const { orderItemRaw, matchStrategy } = orderLink(r);
      const occurredAt = colDate(r, "Transaction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "COMMISSION_FEES",
        marketplaceOrderIdRaw: null,
        orderItemRaw,
        matchStrategy,
        reference: colStr(r, "Invoice Number"),
        occurredAt,
        amount: colNum(r, "Total Commission Amount"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  // ---- Non Order Transactions: account-level adjustments, not order-linked. ----
  if (wb.Sheets["Non Order Transactions"]) {
    for (const r of sheetToRows(wb.Sheets["Non Order Transactions"])) {
      const occurredAt = colDate(r, "Transaction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "NON_ORDER_TXN",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "Invoice Number"),
        occurredAt,
        amount: colNum(r, "Gross Amount"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  // ---- Payments: the literal bank-credit record (UTR-keyed) — the one sheet safe to sum for "Amount Received". ----
  if (wb.Sheets["Payments"]) {
    for (const r of sheetToRows(wb.Sheets["Payments"])) {
      const occurredAt = colDate(r, "Payment Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "BANK_PAYMENT",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "UTR No"),
        occurredAt,
        amount: colNum(r, "Gross Amount"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- ClosingBalance: per-line-item running/closing balance entries feeding into the eventual bank payment. ----
  if (wb.Sheets["ClosingBalance"]) {
    for (const r of sheetToRows(wb.Sheets["ClosingBalance"])) {
      const { orderItemRaw, matchStrategy } = orderLink(r);
      const occurredAt = colDate(r, "Transaction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "CLOSING_BALANCE",
        marketplaceOrderIdRaw: null,
        orderItemRaw,
        matchStrategy,
        reference: colStr(r, "Invoice Number"),
        occurredAt,
        amount: colNum(r, "Amount"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  // ---- TCS: per-line-item tax collected at source. ----
  if (wb.Sheets["TCS"]) {
    for (const r of sheetToRows(wb.Sheets["TCS"])) {
      const { orderItemRaw, matchStrategy } = orderLink(r);
      const occurredAt = colDate(r, "Transaction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "TCS",
        marketplaceOrderIdRaw: null,
        orderItemRaw,
        matchStrategy,
        reference: colStr(r, "Invoice Number"),
        occurredAt,
        amount: colNum(r, "Tax Amount"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  return { marketplace: "SNAPDEAL", periodStart, periodEnd, rows, unrecognizedSheets };
}

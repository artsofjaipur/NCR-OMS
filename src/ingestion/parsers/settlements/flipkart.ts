import * as XLSX from "xlsx";
import { ParsedSettlementRow, ParsedSettlementWorkbook } from "./types";
import { sheetToRows, colStr, colNum, colDate } from "./xlsxUtil";

/** True when this workbook is a Flipkart "payment/settlement" export — this exact combination of tab names is unique to it. */
export function isFlipkartSettlementWorkbook(wb: XLSX.WorkBook): boolean {
  const names = new Set(wb.SheetNames);
  return names.has("Orders") && names.has("GST_Details") && names.has("Storage_Recall") && names.has("Non_Order_SPF");
}

function parsePeriod(wb: XLSX.WorkBook): { start: Date | null; end: Date | null } {
  const ws = wb.Sheets["Summary of report"];
  if (!ws) return { start: null, end: null };
  const grid = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null });
  for (const row of grid) {
    const label = String(row?.[1] ?? "").trim();
    if (label === "Payment Date") {
      const raw = String(row?.[2] ?? "").trim();
      const m = /^(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})$/.exec(raw);
      if (m) return { start: new Date(m[1]), end: new Date(m[2]) };
    }
  }
  return { start: null, end: null };
}

export function parseFlipkartSettlementWorkbook(wb: XLSX.WorkBook): ParsedSettlementWorkbook {
  const rows: ParsedSettlementRow[] = [];
  const { start, end } = parsePeriod(wb);

  const KNOWN_SHEETS = new Set([
    "Report Help", "Summary of report", "Orders", "MP Fee Rebate", "Non_Order_SPF",
    "Storage_Recall", "Ads", "TDS", "GST_Details", "TCS_Recovery",
  ]);
  const unrecognizedSheets = wb.SheetNames.filter((n) => !KNOWN_SHEETS.has(n));

  // ---- Orders: one row per order item, the core per-order settlement. ----
  if (wb.Sheets["Orders"]) {
    for (const r of sheetToRows(wb.Sheets["Orders"])) {
      rows.push({
        lineType: "ORDER_PAYMENT",
        marketplaceOrderIdRaw: colStr(r, "Order ID"),
        orderItemRaw: colStr(r, "Order item ID"),
        matchStrategy: "FLIPKART_ORDER_ITEM",
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Payment Date"),
        amount: colNum(r, "Bank Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- MP Fee Rebate: order-linked, a fee that was refunded back to the seller. ----
  if (wb.Sheets["MP Fee Rebate"]) {
    for (const r of sheetToRows(wb.Sheets["MP Fee Rebate"])) {
      rows.push({
        lineType: "FEE_REBATE",
        marketplaceOrderIdRaw: colStr(r, "Order ID"),
        orderItemRaw: colStr(r, "Order item ID"),
        matchStrategy: "FLIPKART_ORDER_ITEM",
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Payment Date"),
        amount: colNum(r, "Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- Non_Order_SPF: warehouse loss/damage claims — never tied to a live order. ----
  if (wb.Sheets["Non_Order_SPF"]) {
    for (const r of sheetToRows(wb.Sheets["Non_Order_SPF"])) {
      rows.push({
        lineType: "NON_ORDER_CLAIM",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Payment Date"),
        amount: colNum(r, "Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- Storage_Recall: warehousing/removal fees — account-level, not per-order. ----
  if (wb.Sheets["Storage_Recall"]) {
    for (const r of sheetToRows(wb.Sheets["Storage_Recall"])) {
      rows.push({
        lineType: "STORAGE_RECALL",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Payment Date"),
        amount: colNum(r, "Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- Ads: wallet topup/redeem — campaign-level, not per-order. ----
  if (wb.Sheets["Ads"]) {
    for (const r of sheetToRows(wb.Sheets["Ads"])) {
      rows.push({
        lineType: "ADS",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Payment Date"),
        amount: colNum(r, "Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- TDS: income-tax credits — account-level. ----
  if (wb.Sheets["TDS"]) {
    for (const r of sheetToRows(wb.Sheets["TDS"])) {
      rows.push({
        lineType: "TDS",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Payment Date"),
        amount: colNum(r, "Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- TCS_Recovery: account-level. ----
  if (wb.Sheets["TCS_Recovery"]) {
    for (const r of sheetToRows(wb.Sheets["TCS_Recovery"])) {
      rows.push({
        lineType: "TCS",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "NEFT ID"),
        occurredAt: colDate(r, "Transaction Date"),
        amount: colNum(r, "Settlement Value"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- GST_Details: informational fee-level GST re-statement. NOT bank
  // money (it re-explains fees already counted inside Orders/Ads/etc, so
  // summing it in too would double-count) — kept purely for the per-order
  // tax breakdown and for GST filing reference. Order-item-linked only when
  // Service Type is literally "Order Item" (vs "Listing"/"Campaign"/etc).
  if (wb.Sheets["GST_Details"]) {
    for (const r of sheetToRows(wb.Sheets["GST_Details"])) {
      const serviceType = colStr(r, "Service Type");
      const isOrderItem = serviceType === "Order Item";
      rows.push({
        lineType: "GST_DETAIL",
        marketplaceOrderIdRaw: null,
        orderItemRaw: isOrderItem ? colStr(r, "Order Item ID") : null,
        matchStrategy: isOrderItem ? "LINE_ITEM_ID_ONLY" : null,
        reference: colStr(r, "Neft Id"),
        occurredAt: null, // this sheet carries no date column
        amount: colNum(r, "Amount (Rs"),
        countsAsBankMoney: false,
        raw: r,
      });
    }
  }

  return { marketplace: "FLIPKART", periodStart: start, periodEnd: end, rows, unrecognizedSheets };
}

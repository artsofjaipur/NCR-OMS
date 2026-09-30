import * as XLSX from "xlsx";
import { ParsedSettlementRow, ParsedSettlementWorkbook } from "./types";
import { sheetToRows, colStr, colNum, colDate } from "./xlsxUtil";

/** True when this workbook is a Meesho monthly payment export. */
export function isMeeshoSettlementWorkbook(wb: XLSX.WorkBook): boolean {
  const names = new Set(wb.SheetNames);
  return names.has("Order Payments") && names.has("Ads Cost");
}

export function parseMeeshoSettlementWorkbook(wb: XLSX.WorkBook): ParsedSettlementWorkbook {
  const rows: ParsedSettlementRow[] = [];

  const KNOWN_SHEETS = new Set(["Disclaimer", "Order Payments", "Ads Cost", "Referral Payments", "Compensation and Recovery"]);
  const unrecognizedSheets = wb.SheetNames.filter((n) => !KNOWN_SHEETS.has(n));

  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  const trackPeriod = (d: Date | null) => {
    if (!d) return;
    if (!periodStart || d < periodStart) periodStart = d;
    if (!periodEnd || d > periodEnd) periodEnd = d;
  };

  // ---- Order Payments: one row per Sub Order No, the core per-order settlement. ----
  if (wb.Sheets["Order Payments"]) {
    for (const r of sheetToRows(wb.Sheets["Order Payments"])) {
      const subOrderNo = colStr(r, "Sub Order No");
      const occurredAt = colDate(r, "Payment Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "ORDER_PAYMENT",
        marketplaceOrderIdRaw: subOrderNo,
        orderItemRaw: null, // MEESHO_SUBORDER derives both from marketplaceOrderIdRaw itself (split on last "_")
        matchStrategy: subOrderNo ? "MEESHO_SUBORDER" : null,
        reference: colStr(r, "Transaction ID"),
        occurredAt,
        amount: colNum(r, "Final Settlement Amount"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- Ads Cost: campaign-level ad spend, not tied to any one order. ----
  if (wb.Sheets["Ads Cost"]) {
    for (const r of sheetToRows(wb.Sheets["Ads Cost"])) {
      const occurredAt = colDate(r, "Deduction Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "ADS",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "Campaign ID"),
        occurredAt,
        amount: colNum(r, "Total Ads Cost"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- Referral Payments: reward-program payouts, not order-linked. ----
  if (wb.Sheets["Referral Payments"]) {
    for (const r of sheetToRows(wb.Sheets["Referral Payments"])) {
      const occurredAt = colDate(r, "Payment Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "REFERRAL",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "Reward Id"),
        occurredAt,
        amount: colNum(r, "Net Referral Amount"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  // ---- Compensation and Recovery: platform-level adjustments, not order-linked. ----
  if (wb.Sheets["Compensation and Recovery"]) {
    for (const r of sheetToRows(wb.Sheets["Compensation and Recovery"])) {
      const occurredAt = colDate(r, "Date");
      trackPeriod(occurredAt);
      rows.push({
        lineType: "COMPENSATION_RECOVERY",
        marketplaceOrderIdRaw: null,
        orderItemRaw: null,
        matchStrategy: null,
        reference: colStr(r, "Program Name"),
        occurredAt,
        amount: colNum(r, "Amount"),
        countsAsBankMoney: true,
        raw: r,
      });
    }
  }

  return { marketplace: "MEESHO", periodStart, periodEnd, rows, unrecognizedSheets };
}

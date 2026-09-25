/**
 * Generic shape every marketplace settlement-sheet parser normalizes into.
 * See src/db/schema.ts's settlement_entries comment block for the full
 * design writeup (why `raw` carries the whole source row, why only some
 * lineTypes count toward a bank-money total, etc.) — kept there since it's
 * the one place both the schema and every parser must stay consistent with.
 */

/** Matches settlementLineTypeEnum's values in src/db/schema.ts exactly. */
export type SettlementLineType =
  | "ORDER_PAYMENT"
  | "RETURN"
  | "FEE_REBATE"
  | "NON_ORDER_CLAIM"
  | "STORAGE_RECALL"
  | "ADS"
  | "TDS"
  | "TCS"
  | "GST_DETAIL"
  | "COMMISSION_FEES"
  | "NON_ORDER_TXN"
  | "CLOSING_BALANCE"
  | "REFERRAL"
  | "COMPENSATION_RECOVERY"
  | "BANK_PAYMENT";

/**
 * Which convention to use to resolve `marketplaceOrderIdRaw` (+ optional
 * line-item suffix already baked into it by the row-mapper) into a real
 * orders/order_items row. Each marketplace's own order-ingestion parser
 * already established these conventions (see src/ingestion/parsers/*.ts);
 * settlement matching reuses them exactly rather than inventing new ones.
 */
export type OrderMatchStrategy =
  | "FLIPKART_ORDER_ITEM" // marketplaceOrderIdRaw = orders.marketplaceOrderId; orderItemRaw = order_items.marketplaceLineItemId
  | "MEESHO_SUBORDER" // marketplaceOrderIdRaw = orders.marketplaceOrderId (Sub Order No prefix before last "_"); orderItemRaw = the line-seq suffix
  | "LINE_ITEM_ID_ONLY" // marketplaceOrderIdRaw is null; orderItemRaw alone matches order_items.marketplaceLineItemId directly (Snapdeal's "Sub Order No" is line-item-level per the Returns importer's own fallback; Flipkart's GST_Details rows for Service Type "Order Item" carry only the Order Item ID, not the Order ID)
  | null;

export interface ParsedSettlementRow {
  lineType: SettlementLineType;
  marketplaceOrderIdRaw: string | null;
  orderItemRaw: string | null;
  matchStrategy: OrderMatchStrategy;
  reference: string | null;
  occurredAt: Date | null;
  amount: number;
  countsAsBankMoney: boolean;
  raw: Record<string, unknown>;
}

export interface ParsedSettlementWorkbook {
  marketplace: "FLIPKART" | "MEESHO" | "SNAPDEAL";
  periodStart: Date | null;
  periodEnd: Date | null;
  rows: ParsedSettlementRow[];
  /** Sheet names present in the workbook that this parser didn't recognize — surfaced so nothing silently vanishes. */
  unrecognizedSheets: string[];
}

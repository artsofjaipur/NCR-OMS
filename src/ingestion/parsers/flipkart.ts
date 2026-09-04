import { parseCsvToRecords, toNullableNumber } from "../csv";
import { parseFlipkartDate, parseFlipkartMMDDYY } from "../dates";
import { NormalizedOrder } from "../types";

const STATUS_MAP: Record<string, string> = {
  "Ready to dispatch": "READY_TO_DISPATCH",
  "Shipped": "DISPATCHED",
  "Delivered": "DELIVERED",
  "Cancelled": "CANCELLED",
};

/**
 * Flipkart's own export text-guards numeric-looking ID columns with a
 * leading apostrophe (e.g. `'438462135749739102`) so spreadsheet software
 * doesn't mangle them into scientific notation. Strip it before storing.
 */
function stripTextGuard(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value;
}

export function parseFlipkartExport(csvText: string): NormalizedOrder[] {
  const records = parseCsvToRecords(csvText);

  // Group rows by Order Id — one order can have multiple line items.
  const byOrder = new Map<string, Record<string, string>[]>();
  for (const record of records) {
    const orderId = record["Order Id"];
    if (!orderId) continue;
    const bucket = byOrder.get(orderId) ?? [];
    bucket.push(record);
    byOrder.set(orderId, bucket);
  }

  const orders: NormalizedOrder[] = [];
  for (const [orderId, rows] of byOrder) {
    const first = rows[0];
    orders.push({
      marketplaceOrderId: orderId,
      status: STATUS_MAP[first["Order State"]] ?? "CREATED",
      fulfillmentType: first["Order Type"] === "NON_FBF" ? "SELLER_FULFILLED" : "MARKETPLACE_FULFILLED",
      invoiceNumber: first["Invoice No."] || null,
      invoiceDate: first["Invoice Date (mm/dd/yy)"] ? parseFlipkartMMDDYY(first["Invoice Date (mm/dd/yy)"]) : null,
      orderedAt: parseFlipkartDate(first["Ordered On"]),
      items: rows.map((r) => ({
        marketplaceLineItemId: stripTextGuard(r["ORDER ITEM ID"]),
        marketplaceSku: r["SKU"],
        productTitleSnapshot: r["Product"],
        quantity: Number(r["Quantity"]),
        unitPrice: r["Selling Price Per Item"],
        shippingCharge: r["Shipping and Handling Charges"] || "0",
        invoiceAmount: r["Invoice Amount"] || null,
        taxCgst: toNullableNumber(r["CGST"]),
        taxSgst: toNullableNumber(r["SGST"]),
        taxIgst: toNullableNumber(r["IGST"]),
        hsnCode: r["HSN CODE"] || null,
      })),
      shipment: {
        marketplaceShipmentId: first["Shipment ID"] || null,
        awbNumber: first["Tracking ID"] || null,
        recipientName: first["Ship to name"] || first["Buyer name"] || null,
        recipientAddressLine1: first["Address Line 1"] || null,
        recipientAddressLine2: first["Address Line 2"] || null,
        recipientCity: first["City"] || null,
        recipientState: first["State"] || null,
        recipientPincode: first["PIN Code"] || null,
        dispatchWindowStart: first["Dispatch After date"] ? parseFlipkartDate(first["Dispatch After date"]) : null,
        dispatchWindowEnd: first["Dispatch by date"] ? parseFlipkartDate(first["Dispatch by date"]) : null,
        packageLengthCm: first["Package Length (cm)"] || null,
        packageBreadthCm: first["Package Breadth (cm)"] || null,
        packageHeightCm: first["Package Height (cm)"] || null,
        packageWeightKg: first["Package Weight (kg)"] || null,
      },
      rawPayload: { source: "FLIPKART", rows },
    });
  }
  return orders;
}

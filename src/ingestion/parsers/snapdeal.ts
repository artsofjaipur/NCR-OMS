import { parseCsvToRecords } from "../csv";
import { parseSnapdealDateTime } from "../dates";
import { NormalizedOrder } from "../types";

function mapStatus(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (normalized.includes("picked up by courier")) return "READY_TO_DISPATCH";
  if (normalized.includes("shipping provider downloaded soft data")) return "CREATED";
  if (normalized.includes("delivered")) return "DELIVERED";
  if (normalized.includes("cancel")) return "CANCELLED";
  return "CREATED";
}

/**
 * Snapdeal's report is one row per sub-order/shipment, not grouped by order
 * the way Flipkart's export is — most orders in the sample data are single
 * item, so we group defensively by ORDERCODE in case a multi-item order
 * shows up.
 */
export function parseSnapdealExport(csvText: string): NormalizedOrder[] {
  const records = parseCsvToRecords(csvText);

  const byOrder = new Map<string, Record<string, string>[]>();
  for (const record of records) {
    const orderCode = record["ORDERCODE"];
    if (!orderCode) continue;
    const bucket = byOrder.get(orderCode) ?? [];
    bucket.push(record);
    byOrder.set(orderCode, bucket);
  }

  const orders: NormalizedOrder[] = [];
  for (const [orderCode, rows] of byOrder) {
    const first = rows[0];
    const hasReturn = Boolean(first["RETURNINITIATEDON"]?.trim());
    orders.push({
      marketplaceOrderId: orderCode,
      status: hasReturn ? "RTO_INITIATED" : mapStatus(first["STATUS"]),
      fulfillmentType: "SELLER_FULFILLED",
      invoiceNumber: first["INVOICENUMBER"] || null,
      invoiceDate: parseSnapdealDateTime(first["INVOICEDATE"]),
      orderedAt: parseSnapdealDateTime(first["ORDERCREATEDDATE"])!,
      verifiedAt: parseSnapdealDateTime(first["ORDERVERIFIEDDATE"]),
      items: rows.map((r) => ({
        marketplaceLineItemId: r["SUBORDERCODE"],
        marketplaceSku: r["SKUCODE"],
        productTitleSnapshot: r["PRODUCTNAME"],
        quantity: 1,
        // Snapdeal's order-status report exposes MRP, not the amount paid —
        // the real selling price is only known via its settlement report.
        unitPrice: r["MRP"] || "0",
        mrp: r["MRP"] || null,
        taxRate: r["TAXPERCENTAGE"] || null,
      })),
      shipment: {
        marketplaceShipmentId: first["REFERENCECODE"],
        packageId: first["PACKAGEID"] || null,
        awbNumber: first["AWBNO"] || null,
        carrier: first["SHIPPINGPROVIDER"] || null,
        trackingUrl: first["TRACKINGURL"] || null,
        serviceLevel: first["SHIPPINGMETHOD"] || null,
        recipientCity: first["SHIPPINGCITY"] || null,
        dispatchWindowEnd: parseSnapdealDateTime(first["MANIFESTBYDATE"]) ?? parseSnapdealDateTime(first["PROMISEDSHIPDATE"]),
        shippedAt: parseSnapdealDateTime(first["SHIPPEDON"]),
        deliveredAt: parseSnapdealDateTime(first["DELIVEREDON"]),
      },
      rawPayload: {
        source: "SNAPDEAL",
        returnInitiatedOn: first["RETURNINITIATEDON"] || null,
        returnDeliveredOn: first["RETURNDELIVEREDON"] || null,
        reverseAwb: first["REVERSEAWBNO"] || null,
        reverseCourier: first["REVERSECOURIERCODE"] || null,
        rows,
      },
    });
  }
  return orders;
}

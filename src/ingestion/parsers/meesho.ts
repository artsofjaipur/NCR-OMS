import { parseCsvToRecords } from "../csv";
import { parseMeeshoDate } from "../dates";
import { NormalizedOrder } from "../types";

const STATUS_MAP: Record<string, string> = {
  READY_TO_SHIP: "READY_TO_DISPATCH",
  CANCELLED: "CANCELLED",
  SHIPPED: "DISPATCHED",
  DELIVERED: "DELIVERED",
};

/**
 * Meesho's "Sub Order No" is `<order id>_<line sequence>` — the trailing
 * `_1` is a line-item index, not part of the order identity. Split on the
 * *last* underscore since the order id itself is purely numeric here.
 */
function splitSubOrderNo(subOrderNo: string): { orderId: string; lineSeq: string } {
  const idx = subOrderNo.lastIndexOf("_");
  if (idx === -1) return { orderId: subOrderNo, lineSeq: "1" };
  return { orderId: subOrderNo.slice(0, idx), lineSeq: subOrderNo.slice(idx + 1) };
}

/**
 * Meesho's "Ready to Ship" report carries no buyer address and no AWB — it
 * is enough to drive picking, not enough on its own for Daily Dispatch's
 * label/handover step. That needs Meesho's separate label/manifest export.
 */
export function parseMeeshoExport(csvText: string): NormalizedOrder[] {
  const records = parseCsvToRecords(csvText);

  return records.map((r) => {
    const { orderId, lineSeq } = splitSubOrderNo(r["Sub Order No"]);
    return {
      marketplaceOrderId: orderId,
      status: STATUS_MAP[r["Reason for Credit Entry"]] ?? "CREATED",
      fulfillmentType: "SELLER_FULFILLED",
      orderedAt: parseMeeshoDate(r["Order Date"]),
      items: [
        {
          marketplaceLineItemId: lineSeq,
          marketplaceSku: r["SKU"],
          productTitleSnapshot: r["Product Name"],
          variantSize: r["Size"] || null,
          quantity: Number(r["Quantity"]),
          unitPrice: r["Supplier Listed Price (Incl. GST + Commission)"],
          settlementPriceEstimate: r["Supplier Discounted Price (Incl GST and Commision)"] || null,
        },
      ],
      shipment: {
        packetId: r["Packet Id"] || null,
        recipientState: r["Customer State"] || null,
      },
      rawPayload: { source: "MEESHO", catalogId: r["Catalog ID"], orderSource: r["Order source"], row: r },
    };
  });
}

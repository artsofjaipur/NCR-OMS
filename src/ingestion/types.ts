/**
 * The shape every marketplace parser/connector normalizes into, regardless
 * of source format. Order ingestion only ever deals with this — it never
 * sees a raw Flipkart/Meesho/Snapdeal row.
 */
export interface NormalizedOrderItem {
  marketplaceLineItemId?: string | null;
  marketplaceSku: string;
  productTitleSnapshot: string;
  variantSize?: string | null;
  quantity: number;
  unitPrice: string;
  mrp?: string | null;
  shippingCharge?: string | null;
  invoiceAmount?: string | null;
  taxCgst?: string | null;
  taxSgst?: string | null;
  taxIgst?: string | null;
  taxRate?: string | null;
  hsnCode?: string | null;
  settlementPriceEstimate?: string | null;
}

export interface NormalizedShipment {
  marketplaceShipmentId?: string | null;
  packageId?: string | null;
  packetId?: string | null;
  awbNumber?: string | null;
  carrier?: string | null;
  trackingUrl?: string | null;
  serviceLevel?: string | null;
  recipientName?: string | null;
  recipientAddressLine1?: string | null;
  recipientAddressLine2?: string | null;
  recipientCity?: string | null;
  recipientState?: string | null;
  recipientPincode?: string | null;
  dispatchWindowStart?: Date | null;
  dispatchWindowEnd?: Date | null;
  shippedAt?: Date | null;
  deliveredAt?: Date | null;
  packageLengthCm?: string | null;
  packageBreadthCm?: string | null;
  packageHeightCm?: string | null;
  packageWeightKg?: string | null;
}

export interface NormalizedOrder {
  marketplaceOrderId: string;
  status: string;
  fulfillmentType: "SELLER_FULFILLED" | "MARKETPLACE_FULFILLED";
  invoiceNumber?: string | null;
  invoiceDate?: Date | null;
  orderedAt: Date;
  verifiedAt?: Date | null;
  items: NormalizedOrderItem[];
  shipment?: NormalizedShipment | null;
  rawPayload: Record<string, unknown>;
}

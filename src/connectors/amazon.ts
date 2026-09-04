import { MarketplaceConnector, MarketplaceCredentials, NotImplementedError } from "./types";
import { NormalizedOrder } from "../ingestion/types";

/**
 * Amazon.in and Amazon.com share this one connector (same SP-API, different
 * marketplace ID/region) — but real SP-API integration (LWA auth, the
 * Orders/Reports APIs, rate-limit backoff) isn't built. Every method throws
 * honestly instead of silently returning empty data, so a caller can tell
 * the difference between "no orders" and "not implemented."
 */
export function createAmazonConnector(): MarketplaceConnector {
  return {
    marketplace: "AMAZON",
    async fetchOrders(_credentials: MarketplaceCredentials, _since: Date): Promise<NormalizedOrder[]> {
      throw new NotImplementedError("Amazon", "fetchOrders");
    },
    async fetchReturns() {
      throw new NotImplementedError("Amazon", "fetchReturns");
    },
    async fetchPayoutReport() {
      throw new NotImplementedError("Amazon", "fetchPayoutReport");
    },
  };
}

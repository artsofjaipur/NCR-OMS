import { MarketplaceConnector, MarketplaceCredentials } from "./types";
import { NormalizedOrder } from "../ingestion/types";

/**
 * Placeholder connector for a marketplace we haven't wired a live API/CSV
 * pull for yet. Returns an empty order list rather than throwing, so the
 * Account Router can be exercised end-to-end (credential resolution, audit
 * logging, scheduling) before the real fetch logic exists — Flipkart,
 * Meesho and Snapdeal already have real parsers in
 * src/ingestion/parsers/*, used directly by the import routes; this mock
 * stands in for their *live* API pull path plus for Myntra and Ajio, which
 * have no parser yet.
 */
export function createMockConnector(marketplace: string): MarketplaceConnector {
  return {
    marketplace,
    async fetchOrders(_credentials: MarketplaceCredentials, _since: Date): Promise<NormalizedOrder[]> {
      return [];
    },
  };
}

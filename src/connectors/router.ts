import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { marketplaceAccounts } from "../db/schema";
import { decryptJson } from "../security/crypto";
import { MarketplaceConnector, MarketplaceCredentials } from "./types";
import { createMockConnector } from "./mock";
import { createAmazonConnector } from "./amazon";

const connectorsByMarketplace: Record<string, MarketplaceConnector> = {
  FLIPKART: createMockConnector("FLIPKART"),
  MEESHO: createMockConnector("MEESHO"),
  SNAPDEAL: createMockConnector("SNAPDEAL"),
  MYNTRA: createMockConnector("MYNTRA"),
  AJIO: createMockConnector("AJIO"),
  AMAZON_IN: createAmazonConnector(),
  AMAZON_COM: createAmazonConnector(),
};

/**
 * The "switcher": resolves the right connector + that seller account's own
 * decrypted credentials at call time. One connector codebase, 17 brand×
 * marketplace seller accounts.
 */
export async function resolveConnector(
  marketplaceAccountId: number,
): Promise<{ connector: MarketplaceConnector; credentials: MarketplaceCredentials }> {
  const [account] = await db.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, marketplaceAccountId)).limit(1);
  if (!account) {
    throw new Error(`Marketplace account ${marketplaceAccountId} not found`);
  }
  const connector = connectorsByMarketplace[account.marketplace];
  if (!connector) {
    throw new Error(`No connector registered for marketplace ${account.marketplace}`);
  }
  const credentials = decryptJson<MarketplaceCredentials>(account.credentialsEncrypted);
  return { connector, credentials };
}

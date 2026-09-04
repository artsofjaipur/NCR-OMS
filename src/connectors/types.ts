import { NormalizedOrder } from "../ingestion/types";

export interface MarketplaceCredentials {
  [key: string]: string;
}

/**
 * One connector codebase per marketplace, reused across every brand×
 * marketplace seller account by injecting that account's own decrypted
 * credentials at call time — the "switcher" / Account Router pattern.
 */
export interface MarketplaceConnector {
  readonly marketplace: string;
  fetchOrders(credentials: MarketplaceCredentials, since: Date): Promise<NormalizedOrder[]>;
  fetchReturns?(credentials: MarketplaceCredentials, since: Date): Promise<unknown[]>;
  fetchPayoutReport?(credentials: MarketplaceCredentials, since: Date): Promise<unknown[]>;
}

export class NotImplementedError extends Error {
  constructor(marketplace: string, method: string) {
    super(`${marketplace} connector does not implement ${method}() yet`);
  }
}

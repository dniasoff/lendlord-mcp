import type { LendlordClient } from "./client.js";

// Typed views over the parts of Lendlord's responses the tools rely on.
// Field names come from live captures; see docs/api.md.

export interface PropertyDetails {
  _id: string;
  status?: string;
  applicants?: string[];
  clientDetailsId?: string;
  property: Record<string, unknown>;
}

export interface UserPayload {
  _id: string;
  fullname?: string;
  email?: string;
  clientDetailsId?: string;
  teamRole?: string;
  settings?: Record<string, unknown>;
  client?: {
    currency?: string;
    country?: string;
    dateFormat?: string;
    accountLimitations?: Record<string, number>;
    monthlyLimitations?: Record<string, number>;
    [k: string]: unknown;
  };
  applicants?: Record<string, unknown>[];
  portfolioDetails?: PropertyDetails[];
  historicalEntirePortfolio?: unknown[];
}

export interface LendlordDocument {
  _id: string;
  key?: string;
  name: string;
  size?: number;
  date?: string;
  path?: string;
  entities?: { entityType: string; entityId: string }[];
  createdAt?: string;
}

const USER_TTL_MS = 30_000;

/** Shared Lendlord data access with a short cache on the large getUserById payload. */
export class Lendlord {
  private userCache?: { at: number; value: Promise<UserPayload> };

  constructor(readonly client: LendlordClient) {}

  user(fresh = false): Promise<UserPayload> {
    if (fresh || !this.userCache || Date.now() - this.userCache.at > USER_TTL_MS) {
      const value = this.client.get<UserPayload>("/api/getUserById");
      value.catch(() => (this.userCache = undefined));
      this.userCache = { at: Date.now(), value };
    }
    return this.userCache.value;
  }

  invalidate(): void {
    this.userCache = undefined;
  }

  async properties(): Promise<PropertyDetails[]> {
    return (await this.user()).portfolioDetails ?? [];
  }

  async property(id: string): Promise<PropertyDetails> {
    const found = (await this.properties()).find((p) => p._id === id);
    if (!found) throw new Error(`No property with id ${id}. Use list_properties to find ids.`);
    return found;
  }

  documents(): Promise<LendlordDocument[]> {
    return this.client.get<LendlordDocument[]>("/api/documents");
  }
}

export function summariseProperty(p: PropertyDetails) {
  const f = p.property;
  return {
    id: p._id,
    status: p.status,
    address: f["Property Address"],
    postcode: f["Property Postcode"],
    ownership: f["Ownership"],
    type: f["Property Type"],
    bedrooms: f["Number of Bedrooms"],
    value: f["Property Value"],
    purchasePrice: f["Property Purchase Price"],
    purchaseDate: f["Date of Purchase"],
    monthlyRent: f["Rental Monthly Income"],
    mortgageBalance: f["Current Mortgage Balance"],
    lender: f["Lender"],
    rateExpiry: f["Rate Expiry Date"],
  };
}

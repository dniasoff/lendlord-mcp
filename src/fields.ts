// Validation and coercion of field values before they reach Lendlord, which otherwise answers
// human-friendly input like "73 square metres" with a 500 cast error (issue #6).

export type FieldKind = "number" | "area" | "percent" | "date";

export class FieldError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "FieldError";
  }
}

export interface Conversion {
  field: string;
  from: unknown;
  to: unknown;
}

const PROPERTY_PERCENT = /^((FA|SL|BF) )?Current Rate$|^Revert Rate$|^Agent Fee Percent$|^Ownership Percentage \d+$/;
const PROPERTY_DATE = /(Date|Contract End)$|^Date of /;
const PROPERTY_NUMBER = new Set([
  "Property Purchase Price",
  "Property Value",
  "Rental Monthly Income",
  "Original Mortgage Balance",
  "Current Mortgage Balance",
  "Mortgage Monthly Cost",
  "Early Redemption Fee",
  "Early Redemption Amount",
  "Monthly Revert Payment",
  "Number of Units",
  "Number of Bedrooms",
  "Agent Fee Value",
  "Monthly Premium",
  "Council Tax Amount",
  "Ground Rent",
  "Service Charge",
  "Capital Gains Tax",
  "FA Loan Amount",
  "FA Monthly Payment",
  "SL Amount",
  "SL Monthly Payment",
  "BF Loan Amount",
  "BF Monthly Payment",
]);

export function propertyFieldKind(name: string): FieldKind | undefined {
  if (name === "Internal Area") return "area";
  if (PROPERTY_PERCENT.test(name)) return "percent";
  if (PROPERTY_DATE.test(name)) return "date";
  if (PROPERTY_NUMBER.has(name)) return "number";
  return undefined;
}

const TENANT_DATE = /^(dob|tenancyStartDate|tenancyEndDate|firstPaymentDate|rentReviewDate)$/;

export function tenantFieldKind(name: string): FieldKind | undefined {
  if (TENANT_DATE.test(name)) return "date";
  if (name === "rentPayment" || name === "depositAmount") return "number";
  return undefined;
}

const NUMBER_PATTERN = /^\s*[£$€]?\s*(-?\d[\d,]*(?:\.\d+)?|-?\.\d+)\s*(?:(k|m|bn)\b)?\s*(.*?)\s*$/i;
const MONEY_WORDS = /^(gbp|pounds?|pcm|pm|p\/m|\/m|\/month|per month|a month|monthly)?$/i;
const SQM_WORDS = /^(m2|m²|sq\.? ?m|sqm|sq\.? ?metres?|sq\.? ?meters?|square metres?|square meters?|metres? squared)$/i;
const SQFT_WORDS = /^(ft2|ft²|sq\.? ?ft|sqft|sq\.? ?feet|square f(ee|oo)t)$/i;
const SQFT_TO_SQM = 0.09290304;

function parseAmount(field: string, raw: string, allowScale = true): { n: number; rest: string } {
  const m = NUMBER_PATTERN.exec(raw);
  if (!m) throw new FieldError(field, `expected a number, got "${raw}"`);
  const [, digits = "", suffix, tail = ""] = m;
  // Without k/m/bn scaling (e.g. areas), "73 m" keeps its unit text instead of becoming 73 million.
  const rest = !allowScale && suffix ? `${suffix}${tail ? ` ${tail}` : ""}` : tail;
  let n = Number(digits.replace(/,/g, ""));
  const scale = allowScale ? suffix?.toLowerCase() : undefined;
  if (scale === "k") n *= 1_000;
  else if (scale === "m") n *= 1_000_000;
  else if (scale === "bn") n *= 1_000_000_000;
  return { n, rest };
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

export function coerceValue(kind: FieldKind, field: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (kind === "date") {
    if (typeof value !== "string") throw new FieldError(field, "expected a date as YYYY-MM-DD");
    const v = value.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00.000Z`;
    const uk = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
    if (uk) return `${uk[3]}-${uk[2]?.padStart(2, "0")}-${uk[1]?.padStart(2, "0")}T00:00:00.000Z`;
    if (/^\d{4}-\d{2}-\d{2}T/.test(v) && !Number.isNaN(Date.parse(v))) return v;
    throw new FieldError(field, `expected a date as YYYY-MM-DD, got "${value}"`);
  }

  if (typeof value === "boolean" || (typeof value !== "number" && typeof value !== "string")) {
    throw new FieldError(field, `expected a number, got ${JSON.stringify(value)}`);
  }

  if (kind === "percent") {
    if (typeof value === "number") return value > 1 ? round(value / 100, 8) : value;
    const { n, rest } = parseAmount(field, value, false);
    if (rest === "%") return round(n / 100, 8);
    if (rest === "") return n > 1 ? round(n / 100, 8) : n;
    throw new FieldError(field, `expected a percentage like "4.5%", got "${value}"`);
  }

  if (typeof value === "number") return value;
  const { n, rest } = parseAmount(field, value, kind !== "area");

  if (kind === "area") {
    if (rest === "" || SQM_WORDS.test(rest)) return n;
    if (SQFT_WORDS.test(rest)) return round(n * SQFT_TO_SQM, 1);
    throw new FieldError(field, `expected square metres (e.g. 73 or "73 sq m"), got "${value}"`);
  }

  if (MONEY_WORDS.test(rest)) return n;
  throw new FieldError(field, `expected a plain number (e.g. 150000 or "£150,000"), got "${value}"`);
}

/** Coerce every known field; unknown fields pass through. Throws FieldError on the first bad value. */
export function coerceFields(
  fields: Record<string, unknown>,
  kindOf: (name: string) => FieldKind | undefined,
): { values: Record<string, unknown>; conversions: Conversion[] } {
  const values: Record<string, unknown> = {};
  const conversions: Conversion[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const kind = kindOf(field);
    const out = kind ? coerceValue(kind, field, value) : value;
    values[field] = out;
    if (out !== value && kind !== "date") conversions.push({ field, from: value, to: out });
  }
  return { values, conversions };
}

export const PERCENT_NOTE =
  'Percentages (rates, agent fee, ownership) are stored as fractions: send "4.5%" or 4.5 (stored as 0.045); values of 1 or less are taken as fractions already.';

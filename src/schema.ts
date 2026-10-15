// Property fields as named in Lendlord's Add/Edit Property form (captured 2026-10-15).
// Keys are the literal field names Lendlord stores under `property`.
export const EDITABLE_PROPERTY_FIELDS = [
  "Property Address", "Property City", "Property Postcode", "Property Purchase Price", "Property Value",
  "Date of Purchase", "Rental Monthly Income", "Lender", "Mortgage Start Date", "Mortgage End Date",
  "Original Mortgage Balance", "Current Mortgage Balance", "Current Rate", "Rate Expiry Date", "Mortgage Monthly Cost",
  "Revert Rate", "Early Redemption Fee", "Early Redemption Amount", "Monthly Revert Payment", "Mortgage Account Number",
  "Mortgage Application Number", "Broker", "Lender's Contact Number", "Number of Units", "HMO Property",
  "License Number", "License Expiry Date", "Construction Date", "Internal Area", "Midterm Property Inspection Due Date",
  "Fire Alarm Test Date", "Emergency Lighting Test Date", "Smoke Detector Test Date", "Letting Agent", "Letting Agent Phone",
  "Letting Agent Email", "Agent Fee Percent", "Agent Fee Value", "Freeholder Name", "Freeholder Phone", "Freeholder Email",
  "Service Charge Company", "Service Charge Phone", "Service Charge Email",
  "Utility Supplier Gas", "Utility Supplier Gas Account #", "Utility Supplier Gas Phone", "Utility Supplier Gas Tariff", "Utility Supplier Gas Contract End",
  "Utility Supplier Electric", "Utility Supplier Electric Account #", "Utility Supplier Electric Phone", "Utility Supplier Electric Tariff", "Utility Supplier Electric Contract End",
  "Utility Supplier Water", "Utility Supplier Water Account #", "Utility Supplier Water Phone", "Utility Supplier Water Tariff", "Utility Supplier Water Contract End",
  "Utility Supplier Broadband", "Utility Supplier Broadband Account #", "Utility Supplier Broadband Phone", "Utility Supplier Broadband Tariff", "Utility Supplier Broadband Contract End",
  "Policy Number", "Name Of Insurer", "Monthly Premium", "Landlord Insurance Start Date", "Landlord Insurance End Date",
  "Council Name", "Council Tax Amount", "Council Tax Start Date", "Council Tax End Date", "Council Tax Reference Number", "Council Tax Notes",
  "Ground Rent", "Service Charge",
  "Gas Certificate Number", "Gas Certificate Start Date", "Gas Certificate Due Date",
  "Electrical Check Last Check Date", "Electrical Check Next Check Date", "Electrical Check Certificate Number",
  "PAT Testing Certificate Number", "PAT Testing Last Check Date", "PAT Testing Next Check Date",
  "Certificate Date", "EPC Due Date", "Certificate Number", "Energy Efficiency Level",
  "Property Registration Number", "Property Registration Date", "Property Registration Renewal Date",
  "FA Loan Start Date", "FA Loan Amount", "FA Lender", "FA Current Rate", "FA Monthly Payment", "FA Rate Expiry Date", "FA Loan End Date",
  "SL Start Date", "SL Amount", "SL Lender", "SL Current Rate", "SL Monthly Payment", "SL Rate Expiry Date", "SL Loan End Date",
  "BF Start Date", "BF Loan Amount", "BF Lender", "BF Current Rate", "BF Monthly Payment", "BF Rate Expiry Date", "BF Loan End Date",
  "Agent Name", "Agent Phone", "Agent Email", "Date of Viewing", "Property Link 1", "Property Link 2",
  "Property Type", "Number of Bedrooms", "Ownership", "Capital Gains Tax", "Notes",
] as const;

// Recomputed by Lendlord on every save; never sent back.
const COMPUTED = /^(LTV|Equity|Gross Monthly Cashflow|Change In Capital|Cash Investment|Property District|city|Last 12 Months .*|Annual .*|10Y .*)$/;

export function isComputedField(name: string): boolean {
  return COMPUTED.test(name);
}

/** Built-in property document slots (`key` on upload). Any other key creates a custom document. */
export const PROPERTY_DOCUMENT_SLOTS: Record<string, string> = {
  purchaseAgreement: "Purchase Agreement",
  memorandumOfSale: "Memorandum of Sale",
  gasCertificate: "Gas Safety Certificate",
  epc: "EPC",
  eicr: "EICR",
  hmoLicense: "HMO License",
  floorPlan: "Floor Plan",
  insurancePolicy: "Insurance Policy",
  buildingRegulationsApproval: "Building Regulations Approval",
  planningPermissions: "Planning Permissions",
  patTests: "PAT",
  legionellaRiskAssessment: "Legionella Risk Assessment",
  inventory: "Inventory",
  fireRiskAssessment: "Fire Risk Assessment",
  rentersRightActInformationSheet: "The Renters' Rights Act Information Sheet",
  tenancyAgreement: "Tenancy Agreement",
  leaseAgreement: "Lease Agreement",
};

export const DATE_FIELD = /(Date|Contract End)$/;

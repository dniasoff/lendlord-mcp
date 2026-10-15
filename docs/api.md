# Lendlord private API notes

Reverse-engineered on 2026-10-15 from app.lendlord.io (web bundle `runtime.844cffcb…`). Unofficial and subject to change.

## Transport

- Base: `https://app.lendlord.io`. Every endpoint is under `/api/`.
- Auth is a session cookie set by `POST /api/loginUser`. Requests use plain `fetch` with same-origin cookies and send no `Authorization` header.
- Error responses are `content-type: plain/text` with a human-readable message, for example `401 Email or password do not match`.
- Transient failures happen: uploads occasionally return `500 socket hang up` even though the file was stored. `GET /api/documents/:entityType/:entityId` confirms whether it landed before a retry.
- `GET /api/communications` serves at most 100 items per request; page through with `skip`.

## Payload encryption

The web app wraps JSON bodies in both directions:

```
encryptPayload(JSON.stringify(body))  ->  "<16-byte IV hex>:<ciphertext hex>"
```

- Algorithm: `aes-256-ctr`, 32-byte static key, random IV per message.
- The key is a 32-char string literal next to `"aes-256-ctr"` in the main app chunk, inside the module that exports `{ encrypt, decrypt, toMD5 }`. It is **not committed here**. The client should fetch `/login`, follow `runtime.*.bundle.js`, then load chunks until it matches `/"aes-256-ctr",\w="([^"]{32})"/`, and cache the result.
- `handleResponseFromFetch`: when the response `content-type` is a file or text type it is returned as-is; otherwise the body text is decrypted and `JSON.parse`d.
- Multipart (`FormData`) uploads are **not** encrypted.

## Session and bootstrap calls (fired on every page load)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/getUserFromCookie` | `{_id, email, fullname, role, clientDetailsId, passedTwoFA, keepMeLoggedIn, expireDate, …}` |
| POST | `/api/general/jwt` | `{token}`, short-lived JWT, probably for the agents and websocket services |
| GET | `/api/getUserById` | **Master payload**, see below |
| GET | `/api/socketTicket` | `{ticket, expiresInSec}` for realtime |
| GET | `/api/featureFlag` | feature flags |
| GET | `/api/usageCounts` | `{documents, transactions}` |
| GET | `/api/getVersion` | app version |

### `GET /api/getUserById` shape (abridged)

```jsonc
{
  "_id": "…", "fullname": "…", "email": "…", "role": "client", "teamRole": "admin",
  "clientDetailsId": "…",
  "settings": { "emails": {…}, "popups": {…}, "twoFA": { "enabled": false } },
  "client": {
    "customisations": { "headers": {…}, "customAssumptions": {…} },
    "currency": "£", "country": "uk", "dateFormat": "DD/MM/YYYY",
    "accountLimitations": { "numberOfFilesUploadsLeft": 0, "aiQuestionsLeft": 0, … },
    "monthlyLimitations": { … }
  },
  "applicants": [ { "_id", "firstName", "lastName", "email", "employmentStatus", "incomeTaxBand", … } ],
  "portfolioDetails": [
    {
      "_id": "<propertyDetailsId>",
      "status": "active",
      "applicants": ["<applicantId>"],
      "property": {
        "Property Address": "…", "Property Postcode": "…", "Property District": "…", "region": "…",
        "Property Purchase Price": 0, "Property Value": 0, "Date of Purchase": "ISO",
        "Ownership": "Private" | "Company", "Company Name": "<companyId>",
        "Property Type": "Terraced House", "Number of Bedrooms": 2, "HMO Property": "No",
        "Landlord Insurance End Date": "ISO", "Policy Number": "…",
        "Certificate Number": "…", "Certificate Date": "ISO", "EPC Due Date": "ISO",
        "Energy Efficiency Level": "D",
        "Current Mortgage Balance": 0, "Lender": "…", "Current Rate": 0, "Rate Expiry Date": "ISO",
        "Rental Monthly Income": 0, "Gross Monthly Cashflow": 0, "LTV": 0, "Equity": 0,
        "… computed yields / ROI fields …": 0
      }
    }
  ],
  "historicalEntirePortfolio": [ /* monthly snapshots, includes status:"portfolio" aggregate rows */ ]
}
```

Field types (verified 2026-10-15): `Internal Area` is square metres (the app fills it from `floorAreaSqm`). Percentage fields (`Current Rate`, `Revert Rate`, `Agent Fee Percent`, `FA/SL/BF Current Rate`, `Ownership Percentage N`) are stored as **fractions**: the app divides by 100 on save, so 4.5% is `0.045`. Sending a non-numeric string to a numeric field returns `500 Cast to Number failed`.

Property fields use the **human-readable column names** shown in the UI as their keys. Ownership is stored as `"Applicant 1": <applicantId>` plus `"Ownership Percentage 1": 1` (a fraction). Dates are ISO timestamps. Fields such as `LTV`, `Equity`, `Gross Monthly Cashflow`, `Last 12 Months …`, `Annual …` and `10Y …` are recomputed by the server on every save. The full list of editable fields is in `src/schema.ts`.

## Properties

| Method | Path | Body |
|---|---|---|
| POST | `/api/addProperties` | ✅ verified live. enc `{ properties: [{ status:"active"\|"potential", clientDetailsId, property, applicants:[applicantId], assumptions:{} }], country:"uk" }` returns the created array |
| POST | `/api/updateProperty` | ✅ verified live. enc `{ properties: [{ _id, status, clientDetailsId, property, applicants, assumptions }], country }` returns `{ propertiesUpdated, tenantsUpdated }`. **`property` is a full replacement**: send every editable field, because omitted fields are removed |
| PUT | `/api/updateSingleProperty/:id` | enc `{ property, country }` |
| DELETE | `/api/deleteProperty/:id` | ✅ verified live |
| POST | `/api/saleProperty` / PUT `/api/saleProperty/:id` | enc |
| PUT | `/api/unSoldProperty/:id` | |
| GET | `/api/soldProperties` | |
| GET | `/api/getPropertySnapshots/:id` | |
| GET | `/api/getClientSnapshots/:YYYY-MM/:YYYY-MM` | `[{ propertyDetailsId, year, month, status, property:{…} }]` |
| POST | `/api/extractPropertiesFromFile` | multipart `file` (repeatable) |
| POST | `/api/getPropertyDataInfo/:id` | enc |
| GET | `/api/epcAPI?address=&postcode=` | |

## Documents

Constant `o = "/api/documents"`.

| Method | Path | Body |
|---|---|---|
| GET | `/api/documents` | `[{ _id, clientDetailsId, key, name, size, date, path, thumbnail, entities:[{entityType, entityId}], … }]` |
| GET | `/api/documents/:entityType/:entityId` | ✅ documents for one entity |
| POST | `/api/documents` | ✅ verified live. Multipart fields: `key` (slot key such as `gasCertificate`/`epc`/`floorPlan`, or any custom key), `file`, `name`, and `entities` as **one JSON-string field**: `'[{"entityType":"property","entityId":"…"}]'`. Returns the document. Uploads did not reduce `numberOfFilesUploadsLeft` in testing |
| PUT | `/api/documents/:id` | multipart, replaces the file |
| PATCH | `/api/documents/:id` | ✅ verified live. enc `{ name }` renames |
| PATCH | `/api/documents/:docId/:entityType/:entityId` | enc JSON, edits the per-entity link |
| DELETE | `/api/documents/:docId/:entityType/:entityId` | ✅ verified live. Unlinks the document, and deletes it when that was its only link |
| POST | `/api/documents/copy` | ✅ enc `{ entities, key, path }`. Creates a **new copy** of the document (new id) on the target entities, named `<timestamp>_<key>.<ext>`, so rename it afterwards |
| POST | `/api/documents/:id/send` | enc `{ email, subject, message, cc, replyTo }`, ✅ emails the document with the file attached. `cc` is an array of addresses; `replyTo` defaults to the account email |
| GET | `/api/getSignedUrl?download=&url=&fileName=` | S3 signed download URL |
| POST | `/api/general/uploadTempFile` | multipart `key`, `file`, `name` |
| POST | `/api/openAI/extractDataFromCertificate` | multipart `{ file, certificateType }` |
| GET | `/api/documentCollection` | document collections (sign/requests) |

Entity types seen: `property`, `tenant`, `portfolio`. Property document slots (key → label) are listed in `src/schema.ts`. The upload dialog accepts `message/rfc822`, so `.eml` emails can be stored directly.

### Property Photos gallery

The Photos gallery is stored separately in `property.images`; uploading a normal document does not add a gallery photo. The web app's legacy gallery uploader sends `PUT /api/legacy/documents/property/:propertyId` as multipart with `key` (unique image key), `file`, `name`, and `collectionName=images`. To remove one image, it sends encrypted JSON `{ key, collectionName: "images" }` to `POST /api/legacy/documents/remove/property/:propertyId`. The `update_property_images` tool wraps these endpoints; add new images before removing old keys when replacing them.

## Tenants and rent

Tenants are read from `getUserById.tenants`. `/api/getClientTenants` returned `[]` for a landlord account and appears to be for other roles.

| Method | Path | Body |
|---|---|---|
| POST | `/api/addTenant/:clientDetailsId` | ✅ enc `{ tenant: { name, email, propertyDetailsId, status:"Actual"\|"Prospect", rentPayment, paymentFrequency, tenancyStartDate, … , subTenants:[] } }` returns the tenant. Lendlord also auto-attaches a "Renters' Rights Act Information Sheet" document to the new tenant |
| PUT | `/api/updateTenant/:id` | ✅ enc `{ tenant: <full tenant> }` |
| DELETE | `/api/deleteTenant/:id` | ✅ |

Tenant form fields: `name, email, phone, mobile, dob, notes, propertyDetailsId, unitName, tenancyStartDate, generatePaymentScheduleFor (3/6/12/24 months), rentPayment, paymentFrequency (Weekly|Bi-Weekly|Four-Weekly|Monthly|Quarterly|4 Months|6 Months|Annually|Free), firstPaymentDate, rentReviewFrequency, rentReviewDate, guarantorContactDetails, depositScheme (TDS|DPS|Mydeposits|Zerodeposits|FlatFair|SafeDeposits|Other), depositAmount`, plus the Yes/No flags `guarantor, inventoryUndertaken, legionellaInspectionRequired, rollingTenancy`.

| Method | Path |
|---|---|
| GET/POST/PUT | `/api/tenant`, `/api/tenant/details` (tenant-portal side) |
| GET | `/api/getRentCollection/:DD-MM-YYYY/:DD-MM-YYYY` returns `[{ tenantsId, dueDate, expected, transactionsInfo, tenant:{_id,name,propertyDetailsId} }]` |
| GET | `/api/tenant/paymentSchedule/:…` |
| POST | `/api/tenancyAgreement/:id` (enc) |

## Money

| Method | Path | Notes |
|---|---|---|
| GET | `/api/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&status=mapped` | |
| GET | `/api/getAggregatedTransaction/:id` | ✅ one transaction (returned as a one-element array; empty for unknown ids) |
| GET | `/api/getTransactionsFromLastLogin` returns `{ newTransactions, mappedTransactions }` | |
| GET | `/api/pnlData` returns `{ data: { <propertyDetailsId>: { months: { "YYYY-MM": … }, purchaseCosts } } }` | |
| GET | `/api/pnlCategory`, `/api/pnlCategoryMapping` | |

### Bank transaction receipts (attachments)

A bank/manual transaction's attachment is a **receipt stored on the transaction** as `file: { url, name }` (S3 path `Receipts/<client>/Transactions/<id>/<timestamp>_<name>`). It is **not** in the documents store: `GET /api/documents/transaction/:id` is always empty and `upload_document` cannot reach it. A transaction holds one receipt.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/transactions` | ✅ multipart, creates a transaction. Required: `clientDetailsId`, `description`, `type` (`received`\|`spent`), `amount`, `date`. `bankAccountId: ""` makes it a manual transaction (no bank feed) |
| PUT | `/api/transactions/:id` | ✅ multipart. The web app re-sends **every plain value** of the transaction (strings, numbers, booleans, nulls; not nested objects such as the populated `category`) plus `file` (the new receipt) and `fileName`. Send `removeReceipt=true` instead of `file` to delete the receipt. Omitting both keeps the existing receipt. Returns `{ transaction }` |
| GET | `/api/getSignedUrl?download=true&url=<file.url>&fileName=<file.name>` | ✅ returns `{ url }`, a temporary S3 link |
| POST | `/api/transaction/delete` | ✅ enc `{ transactionsIds: [id], isPermanently: false }` soft-deletes (Deleted tab); `true` deletes for good |
| POST | `/api/transaction/restore` | enc `{ transactionsIds }` |

Date filters treat `endDate` as midnight, so a transaction with a time-of-day component on the end date is excluded (bank transactions are dated at midnight).

## Communications (maintenance reports and messages)

Constant `a = "/api/communications"`.

| Method | Path | Body |
|---|---|---|
| GET | `/api/communications?type=&skip=&limit=` | returns `{ communications, hasMore }`, page through it with skip/limit=100 |
| GET | `/api/communications/:id?type=` | |
| GET | `/api/communications/maintenanceTypes` | |
| POST | `/api/communications` | ✅ enc `{ propertyDetailsId, tenant:[tenantIds], shared:false, summary, description, status:"open", type:"maintenanceReport", maintenanceType }`. Returns **a one-element array**, and status `201` |
| PUT | `/api/communications/:id` | ✅ enc partial, e.g. `{ status:"open"\|"closed" }` or `{ archived:true }` |
| DELETE | `/api/communications/:id` | ✅ deleting a property also deletes its reports |
| DELETE | `/api/communications/:id/files/:fileId` | |
| POST | `/api/communications/:id/message` | ✅ multipart: `type` (`"note"` = internal, `"message"` = reply visible to the tenant), `message`, `deferUpload:"true"`, optional `file` (repeatable) |

Landlords cannot create a `conversation` without a tenant: `POST /api/communications {type:"conversation", tenant:[]}` returns `500 Argument passed in does not match the accepted types`. A maintenance report accepts a client-supplied **`createdAt`**, which is stored as given (used for back-dated history by `log_communication`). Unknown fields are dropped.

Types: `maintenanceReport`, `conversation`. Maintenance types (`maintenanceType`): Air-conditioning, Heating and boiler, Electricity, Internet, Lighting, Plumbing, Water or leaks, Basin, Bathroom and Toilet, Laundry, Alarms and smoke detectors, Security camera system maintenance, Intercom, Doors and locks, Pests/Vermin, Floors walls and ceilings, Structural Issues, Windows, Furniture, Kitchen, Appliances, Mold, Cleaning, Carpentry, Exterior Maintenance, Roof, Garden, Garage, Shared facilities, Bike storage, Bin storage, Chimney, Stairs, Other.

## Tasks and alerts ("opportunities")

Read from `getUserById.opportunities`. Each item has a `category`: `task` (custom tasks, plus generated ones such as `MISSING_DUE_DATES` and `NO_TENANTS`) or `alert` (such as `Payment Overdue`, with `propertyId`, `tenantsId` and `paymentAmount`).

| Method | Path | Body |
|---|---|---|
| POST | `/api/opportunities` | ✅ enc `{ subject, description, expiry_date (ISO), propertyId?, level:"client", category:"task", type:"CUSTOM_TASK", clientId:<clientDetailsId> }` |
| PUT | `/api/opportunities/:id` | ✅ enc partial. Status values: `"active"`, `"inActive"` (completed), `"inActiveDeleted"` (deleted; the record is kept). ⚠️ returns 200 even for unknown ids |

## Email

- There is **no inbound-email or alias API** for users. `/aliases` and `/drafts` redirect non-admins to `/dashboard`.
- Outbound: `POST /api/general/sendEmailToAddresses` (enc) and `POST /api/documents/:id/send`.
- This project builds email-to-property filing on top of document upload. See the README.

## Everything else

`endpoints-raw.txt` lists every non-admin `/api/...` string literal found in the bundle, with template params shown as `:param`. Paths built from constants (for example `${o}/copy`) may show up only as their base.

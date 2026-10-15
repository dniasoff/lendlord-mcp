# Lendlord private API notes

Reverse-engineered on 2026-10-15 from app.lendlord.io (web bundle `runtime.844cffcb…`). Unofficial and subject to change.

## Transport

- Base: `https://app.lendlord.io`. Every endpoint is under `/api/`.
- Auth is a session cookie set by `POST /api/loginUser`. Requests use plain `fetch` with same-origin cookies and send no `Authorization` header.
- Error responses are `content-type: plain/text` with a human-readable message, for example `401 Email or password do not match`.

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

Property fields use the **human-readable column names** shown in the UI as their keys.

## Properties

| Method | Path | Body |
|---|---|---|
| POST | `/api/addProperties` | enc `{ properties: [{ property, applicants, … }], country }` returns the created array |
| POST | `/api/updateProperty` | enc `{ properties: [{ _id, clientDetailsId, property, applicants, status }], country }` returns `{ propertiesUpdated }` |
| PUT | `/api/updateSingleProperty/:id` | enc `{ property, country }` |
| DELETE | `/api/deleteProperty/:id` | |
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
| GET | `/api/documents/:entityType/:entityId` | documents for one entity |
| POST | `/api/documents` | multipart built by a helper that flattens an object into FormData (arrays become indexed keys). Fields seen: `key`, `file`, `name`, `entities`, optional `type`, `collectionName`, `thumbnailTemplate` |
| PUT | `/api/documents/:id` | multipart, replaces the file |
| PATCH | `/api/documents/:id` | enc JSON, updates metadata |
| PATCH | `/api/documents/:a/:b/:c` | enc JSON |
| DELETE | `/api/documents/:a/:b/:c` | the three path params are unconfirmed |
| POST | `/api/documents/copy` | enc `{ entities, key, path, … }`, links an existing file to other entities |
| POST | `/api/documents/:id/send` | enc, emails the document |
| GET | `/api/getSignedUrl?download=&url=&fileName=` | S3 signed download URL |
| POST | `/api/general/uploadTempFile` | multipart `key`, `file`, `name` |
| POST | `/api/openAI/extractDataFromCertificate` | multipart `{ file, certificateType }` |
| GET | `/api/documentCollection` | document collections (sign/requests) |

Entity types seen: `property`, `tenant`, `portfolio`.

## Tenants and rent

| Method | Path |
|---|---|
| GET | `/api/getClientTenants` |
| GET/POST/PUT | `/api/tenant`, `/api/tenant/details` |
| GET | `/api/getRentCollection/:DD-MM-YYYY/:DD-MM-YYYY` returns `[{ tenantsId, dueDate, expected, transactionsInfo, tenant:{_id,name,propertyDetailsId} }]` |
| GET | `/api/tenant/paymentSchedule/:…` |
| POST | `/api/tenancyAgreement/:id` (enc) |

## Money

| Method | Path |
|---|---|
| GET | `/api/transactions?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&status=mapped` |
| GET | `/api/getTransactionsFromLastLogin` returns `{ newTransactions, mappedTransactions }` |
| GET | `/api/pnlData` returns `{ data: { <propertyDetailsId>: { months: { "YYYY-MM": … }, purchaseCosts } } }` |
| GET | `/api/pnlCategory`, `/api/pnlCategoryMapping` |

## Communications (maintenance reports and messages)

Constant `a = "/api/communications"`.

| Method | Path | Body |
|---|---|---|
| GET | `/api/communications?type=&skip=&limit=` | returns `{ communications, hasMore }`, page through it with skip/limit=100 |
| GET | `/api/communications/:id?type=` | |
| GET | `/api/communications/maintenanceTypes` | |
| POST | `/api/communications` | enc JSON, or multipart when files are included |
| PUT | `/api/communications/:id` | enc |
| DELETE | `/api/communications/:id` | |
| DELETE | `/api/communications/:id/files/:fileId` | |
| POST | `/api/communications/:id/message` | multipart |

## Email

- There is **no inbound-email or alias API** for users. `/aliases` and `/drafts` redirect non-admins to `/dashboard`.
- Outbound: `POST /api/general/sendEmailToAddresses` (enc) and `POST /api/documents/:id/send`.
- This project builds email-to-property filing on top of document upload. See the README.

## Everything else

`endpoints-raw.txt` lists every non-admin `/api/...` string literal found in the bundle, with template params shown as `:param`. Paths built from constants (for example `${o}/copy`) may show up only as their base.

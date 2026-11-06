# Redesign Phase 5: Receive (part 1: draft receipts)

Phase 5's backend check found that draft receipts did not exist and that buying prices are set after the fact (not approved
before stock goes in). Decision taken: **option 1**. A draft saves without touching stock; submitting does today's receive
(stock goes in then); buying prices stay a separate later step done by someone with costing rights.

This note covers the drafts. The visual restyle of the Receive form waits on the mockups.

## Backend

| Part | File |
| --- | --- |
| Migration `0002_draft_receipts` (the first numbered migration) | `backend/src/db/migrations/0002_draft_receipts.sql` |
| Service | `backend/src/services/stockReceiptDrafts.service.js` |
| Controller and routes | `controllers/stockReceiptDrafts.controller.js`, `routes/stock.routes.js` |

| Route | Does |
| --- | --- |
| `GET /api/stock/receipts/drafts` | your own drafts; a stock reviewer sees the whole branch's |
| `POST /api/stock/receipts/drafts` | save a new draft (same body as a receipt, but incomplete is fine) |
| `GET /api/stock/receipts/drafts/:id` | open one |
| `PUT /api/stock/receipts/drafts/:id` | replace its contents |
| `DELETE /api/stock/receipts/drafts/:id` | delete it |
| `POST /api/stock/receipts/drafts/:id/submit` | receive it for real, then remove the draft |

All need `stock.receive`. A draft you may not open is "not found", not "forbidden".

### Why it cannot hurt stock

- A draft is a row in its own table, `stock_receipt_drafts`, holding the request as JSON. It is not a receipt: no receipt, item,
  batch, movement, supplier, product or category is created, so nothing in a draft reaches on-hand counts, valuation or reports.
- Submitting runs the ordinary `createReceipt` and deletes the draft **in one transaction**. If the receive is refused,
  nothing happens and the draft is still there with the error; a second submit finds no draft, so one draft cannot put stock in
  twice. Stock still goes in through `stock.service` only (the R1 rule); no new writer was added.
- Every rule is checked at submit, as for a direct receive. Saving refuses only what makes a draft unusable: not the main store,
  an impossible or future date, a supplier that does not exist, more than 200 lines, a body over 256 KB.
- A buying price is dropped before saving for anyone who may not set one, and hidden when read, so it is never stored on their
  behalf. A new supplier or new product named in a draft is created only at submit.

## Frontend (new layout, `ut_ui=v2`, Stock > Receive)

- A **Drafts** list above the receipts: supplier, delivery note, number of lines, who started it, when saved, Continue and Delete.
- **Save draft** beside the primary button. It keeps whatever is filled in, checks nothing, and tells the person nothing has been
  received yet.
- **Continue** reopens the form as it was left. Finishing it ("Save shipment") checks the form the same way as before, sends the
  final form into the draft, and submits that draft.
- For someone who cannot enter buying prices, a line says they are set by a manager or admin after the shipment is received.
- With the flag off the form is exactly as it was and the drafts are never requested.

An existing-product line in a draft carries a small `display` reminder (`{ name, sku }`) so a reopened draft can show the product
without looking it up. The receive ignores it (tested).

## Tests

Backend `stockReceiptDrafts.test.js` (20): saving touches no stock, receipt, batch or movement; incomplete drafts are kept; what is
refused; main store only; permission; who sees what and "not found"; buying prices never stored or shown to someone who may not set
them; submit puts stock in once, cannot double-post, and leaves the draft and stock untouched when refused; supplier and product
created only at submit; the integrity check stays clean; the migration is applied once. `migrations.test.js` now derives the
expected versions from the folder instead of hard-coding "only 0001". Frontend `receiptDraft.test.js` (the round trip),
`ReceiveTab.drafts.test.jsx` (both layouts). Backend 93 files, 1,107 tests; frontend 69 files, 510 tests.

## Deploying (this one changes the database)

1. Back up the live database.
2. Try it on a copy first: `npm run migrate -- --status`, then `npm run migrate`, then `npm run integrity`. The runner also makes its
   own backup in `backups/` before applying a pending migration. It applies `0002` once and a second run changes nothing (checked
   on a seeded copy here, not on live data).
3. Roll out at a quiet time. Nothing in the old receive path changed; drafts only appear with the flag on.

## Decisions taken and not done

- **"Submit for approval" is not a stock gate** (option 1). The button keeps its current label, "Save shipment"; "Set by admin"
  means the existing costing step, which is a manager or admin with `products.view_cost` and `stock.review`, not admin only.
- **Selling price per line** for an existing product is still not on the form: the receive records the product's current price and
  takes no per-line price. A new product's price is entered as before.
- **The Receive restyle** (the mockup's layout) is not started; the mockups are not in the repo.
- **Not looked at in a browser.** As a storekeeper with the flag on: save a draft, see it listed, Continue, finish it, and check
  the stock went in once; save two drafts as two storekeepers and check each sees only their own; as a manager, see both.
- The form's labels are not linked to their inputs (screen readers cannot tell which is which). Not changed here; it belongs in the
  Phase 7 accessibility pass.

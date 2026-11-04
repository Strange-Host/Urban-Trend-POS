const { z } = require('zod');

// Prices are INTEGER CENTS everywhere in this app (checkout compares payments to the total exactly), so a negative,
// fractional or absurdly large price is never legitimate - and until now nothing stopped a manager saving one.
const MAX_CENTS = 10_000_000_000;   // 100 million in major units: far above any real price, far below integer overflow risk
const cents = z.number().int().min(0).max(MAX_CENTS);

// The product form posts category_id straight from a <select>, so it arrives as the string "3" as often as the number 3.
const id = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive()),
]);

// A picture is a web address (or a path on this server). Anything else - javascript:, data:, file: - is refused so it
// can never end up in an <img src> or a link.
const imageUrl = z.union([
  z.literal(''),
  z.string().max(2000).regex(/^(https?:\/\/|\/)[^\s]*$/i, 'must be an http(s) address or a path starting with /'),
]);

const fields = {
  sku: z.string().min(1).max(64),
  barcode: z.string().max(64).nullish(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  category_id: id.nullish(),
  brand: z.string().max(100).nullish(),
  cost_price: cents.nullish(),
  sell_price: cents,
  image_url: imageUrl.nullish(),
};

// Unknown keys are dropped (zod's default), so the form can keep spreading its whole state into the request.
const createProductSchema = z.object(fields);

// PUT keeps whatever is omitted (see products.controller.js update()), so every field is optional here.
// `reason` is optional on the web (it is stored with the price history when the selling price changes).
const updateProductSchema = z.object(fields).partial().extend({ reason: z.string().trim().max(300).optional() });

module.exports = { createProductSchema, updateProductSchema, MAX_CENTS };

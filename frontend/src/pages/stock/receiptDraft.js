import { toCents } from './helpers';

// Turning the Receive form into a draft and back. Pure functions, so the round trip can be tested without the form.
//
// A draft is the request body that would be sent to POST /stock/receipts, saved before it is finished, so unlike a real
// receive nothing is refused here: whatever is filled in is kept, whatever is blank or not yet valid is left out. The
// receive itself (on submit) is where every rule is checked.
//
// An existing-product line also carries `display` ({ name, sku, sell_price }): only a reminder of how the line looked, so reopening the
// draft can show the product without looking it up. The server's receive ignores it; the product id is what counts.

/** @typedef {import('../../types').Payload} Payload */

/**
 * @param {{ supplierId: unknown, reference: string, note: string, lines: any[], canCost: boolean }} form
 * @returns {Payload}
 */
export function draftBodyFromForm({ supplierId, reference, note, lines, canCost }) {
  const items = [];
  for (const l of lines) {
    /** @type {Payload} */
    const item = {};
    const quantity = parseInt(l.qty, 10);
    if (Number.isInteger(quantity) && quantity > 0) item.quantity = quantity;
    if (l.batchNo.trim()) item.batch_no = l.batchNo.trim();
    if (l.expiry) item.expiry_date = l.expiry;
    if (canCost && l.cost !== '') {
      const cost = toCents(l.cost);
      if (Number.isFinite(cost) && cost >= 0) item.unit_cost = cost;
    }
    if (l.mode === 'existing') {
      if (l.product) {
        item.product_id = l.product.id;
        item.display = { name: l.product.name, sku: l.product.sku };
        if (Number.isFinite(l.product.sell_price)) item.display.sell_price = l.product.sell_price; // so a reopened draft can show the price
      }
    } else {
      /** @type {Payload} */
      const np = {};
      if (l.name.trim()) np.name = l.name.trim();
      const price = toCents(l.price);
      if (l.price !== '' && Number.isFinite(price) && price >= 0) np.sell_price = price;
      if (l.image.trim()) np.image_url = l.image.trim();
      if (l.subOn) {
        if (l.subName.trim()) np.new_category = { name: l.subName.trim(), parent_id: l.parentId ? Number(l.parentId) : undefined };
      } else if (l.categoryId) np.category_id = Number(l.categoryId);
      item.new_product = np;
    }
    if (Object.keys(item).length > 0) items.push(item); // a line with nothing in it is not worth keeping
  }
  return {
    supplier_id: supplierId ? Number(supplierId) : undefined,
    reference: reference.trim() || undefined,
    note: note.trim() || undefined,
    items,
  };
}

/**
 * @param {Payload} body  a draft's saved body
 * @param {() => any} makeLine  the form's blank-line factory (gives each line its key)
 */
export function linesFromDraft(body, makeLine) {
  const lines = (body.items || []).map((/** @type {Payload} */ it) => {
    const line = makeLine();
    if (it.quantity !== undefined) line.qty = String(it.quantity);
    line.batchNo = it.batch_no || '';
    line.expiry = it.expiry_date || '';
    if (it.unit_cost !== undefined) line.cost = String(it.unit_cost / 100);
    if (it.new_product) {
      const np = it.new_product;
      line.mode = 'new';
      line.name = np.name || '';
      line.price = np.sell_price !== undefined ? String(np.sell_price / 100) : '';
      line.image = np.image_url || '';
      if (np.new_category) {
        line.subOn = true;
        line.subName = np.new_category.name || '';
        line.parentId = np.new_category.parent_id ?? '';
      } else if (np.category_id) line.categoryId = np.category_id;
    } else if (it.product_id) {
      line.product = { id: it.product_id, name: it.display?.name || `Product #${it.product_id}`, sku: it.display?.sku || '', sell_price: it.display?.sell_price };
    }
    return line;
  });
  return lines.length > 0 ? lines : [makeLine()];
}

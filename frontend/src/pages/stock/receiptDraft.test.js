import { describe, it, expect } from 'vitest';
import { draftBodyFromForm, linesFromDraft } from './receiptDraft';

let key = 0;
const blank = () => ({ key: ++key, mode: 'existing', product: null, qty: '', batchNo: '', expiry: '', cost: '', name: '', price: '', image: '', categoryId: '', subOn: false, parentId: '', subName: '' });
const line = (o) => ({ ...blank(), ...o });
const form = (o = {}) => ({ supplierId: '', reference: '', note: '', lines: [blank()], canCost: false, ...o });

describe('draftBodyFromForm', () => {
  it('keeps whatever is filled in and refuses nothing', () => {
    const body = draftBodyFromForm(form({
      supplierId: 7, reference: ' DN-9 ', lines: [
        line({ product: { id: 5, name: 'Soap', sku: 'S-1' }, qty: '12', batchNo: 'B1', expiry: '2027-01-01' }),
        line({ qty: 'abc' }),                                // half-typed and wrong: left out, not an error
      ],
    }));
    expect(body).toEqual({
      supplier_id: 7, reference: 'DN-9', note: undefined,
      items: [{ quantity: 12, batch_no: 'B1', expiry_date: '2027-01-01', product_id: 5, display: { name: 'Soap', sku: 'S-1' } }],
    });
  });

  it('drops lines with nothing in them, and an entirely blank form is an empty draft', () => {
    expect(draftBodyFromForm(form()).items).toEqual([]);
  });

  it('keeps a new product as new even before it is named, so the toggle survives', () => {
    const body = draftBodyFromForm(form({ lines: [line({ mode: 'new' })] }));
    expect(body.items).toEqual([{ new_product: {} }]);
  });

  it('turns prices into whole cents and keeps a new sub-category or a chosen one', () => {
    const body = draftBodyFromForm(form({ lines: [
      line({ mode: 'new', name: 'Brand new', price: '12.50', qty: '3', subOn: true, subName: 'Mugs', parentId: 4 }),
      line({ mode: 'new', name: 'Other', price: '1', categoryId: 9 }),
    ] }));
    expect(body.items[0].new_product).toEqual({ name: 'Brand new', sell_price: 1250, new_category: { name: 'Mugs', parent_id: 4 } });
    expect(body.items[1].new_product).toEqual({ name: 'Other', sell_price: 100, category_id: 9 });
  });

  it('includes a buying price only for someone who may set one', () => {
    const lines = [line({ product: { id: 1, name: 'A', sku: 'a' }, qty: '2', cost: '3.5' })];
    expect(draftBodyFromForm(form({ lines, canCost: true })).items[0].unit_cost).toBe(350);
    expect(draftBodyFromForm(form({ lines, canCost: false })).items[0]).not.toHaveProperty('unit_cost');
  });
});

describe('linesFromDraft', () => {
  const make = () => blank();

  it('gives a blank line back for an empty draft', () => {
    expect(linesFromDraft({ items: [] }, make)).toHaveLength(1);
    expect(linesFromDraft({}, make)).toHaveLength(1);
  });

  it('restores an existing-product line from its saved reminder', () => {
    const [l] = linesFromDraft({ items: [{ product_id: 5, quantity: 12, batch_no: 'B1', expiry_date: '2027-01-01', display: { name: 'Soap', sku: 'S-1' } }] }, make);
    expect(l).toMatchObject({ mode: 'existing', qty: '12', batchNo: 'B1', expiry: '2027-01-01', product: { id: 5, name: 'Soap', sku: 'S-1' } });
  });

  it('still opens a line whose reminder is missing', () => {
    const [l] = linesFromDraft({ items: [{ product_id: 5, quantity: 1 }] }, make);
    expect(l.product).toEqual({ id: 5, name: 'Product #5', sku: '' });
  });

  it('survives the round trip, for existing and new products', () => {
    const original = form({ supplierId: 3, reference: 'R', canCost: true, lines: [
      line({ product: { id: 5, name: 'Soap', sku: 'S-1' }, qty: '12', cost: '2.5' }),
      line({ mode: 'new', name: 'Brand new', price: '12.5', qty: '3', categoryId: 9, image: 'http://x/y.png' }),
      line({ mode: 'new', name: 'In a new group', price: '4', subOn: true, subName: 'Mugs', parentId: 4 }),
    ] });
    const body = draftBodyFromForm(original);
    const back = linesFromDraft(body, make);
    expect(draftBodyFromForm({ ...original, lines: back })).toEqual(body);
    expect(back[1].categoryId).toBe(9);   // numbers stay numbers, so the pickers still match their options
    expect(back[2].parentId).toBe(4);
  });
});

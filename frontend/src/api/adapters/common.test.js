import { describe, it, expect } from 'vitest';
import { toLegacyPage, toLimitOffset, snakeKeys, camelKeys, notImplemented, NotImplementedOnNewServer } from './common';
import { getErrorMessage } from '../client';

describe('paging', () => {
  it('turns rows and a total into the legacy list shape', () => {
    expect(toLegacyPage([{ id: 1 }], 101, { page: 2, pageSize: 50 })).toEqual({ data: [{ id: 1 }], page: 2, pageSize: 50, total: 101, totalPages: 3 });
    expect(toLegacyPage([], 0).totalPages).toBe(1);
  });
  it('turns page and pageSize (or limit) into limit and offset', () => {
    expect(toLimitOffset({ page: 3, pageSize: 25 })).toEqual({ limit: 25, offset: 50 });
    expect(toLimitOffset({ limit: 10 })).toEqual({ limit: 10, offset: 0 });
    expect(toLimitOffset({ page: -4, pageSize: 'x' })).toEqual({ limit: 50, offset: 0 });
  });
});

describe('key casing', () => {
  it('maps camelCase to snake_case and back, deeply, touching only plain objects', () => {
    const d = new Date();
    expect(snakeKeys({ orderRef: 'A', items: [{ unitPriceCents: 5 }], when: d })).toEqual({ order_ref: 'A', items: [{ unit_price_cents: 5 }], when: d });
    expect(camelKeys({ order_ref: 'A', items: [{ unit_price_cents: 5 }] })).toEqual({ orderRef: 'A', items: [{ unitPriceCents: 5 }] });
  });
});

describe('calls the new server cannot do yet', () => {
  it('reject with an error the pages already know how to show, and never fall back to the legacy backend', async () => {
    const err = await notImplemented('ordersApi.inspect')().catch((e) => e);
    expect(err).toBeInstanceOf(NotImplementedOnNewServer);
    expect(getErrorMessage(err)).toBe('ordersApi.inspect is not available on the new server yet.');
    expect(err.response.data.error.code).toBe('NOT_IMPLEMENTED_ON_NEW_SERVER');
  });
});

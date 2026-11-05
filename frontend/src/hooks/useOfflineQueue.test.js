import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/endpoints', () => ({ salesApi: { checkout: vi.fn() } }));

import { salesApi } from '../api/endpoints';
import useOfflineQueue from './useOfflineQueue';

const payload = (n = 1) => ({ items: [{ product_id: n, quantity: 1 }], payments: [{ method: 'cash', amount: 1000 * n }] });
const httpError = (status, message = 'nope') => Object.assign(new Error(message), { response: { status, data: { error: { message } } } });
const state = () => useOfflineQueue.getState();

beforeEach(() => {
  salesApi.checkout.mockReset();
  useOfflineQueue.setState({ queue: [], syncing: false, lastSyncError: '' });
});

describe('offline sale queue', () => {
  it('queues a sale with a client id carried on both the entry and the payload', () => {
    const entry = state().enqueue(payload());
    expect(entry.clientSaleId).toBeTruthy();
    expect(entry.payload.clientSaleId).toBe(entry.clientSaleId);
    expect(state().queue).toHaveLength(1);
    expect(state().pendingCount()).toBe(1);
  });

  it('keeps the client id the till already generated (that id is the idempotency key)', () => {
    const entry = state().enqueue({ ...payload(), clientSaleId: 'abc-123' });
    expect(entry.clientSaleId).toBe('abc-123');
    expect(entry.payload.clientSaleId).toBe('abc-123');
  });

  it('sends queued sales oldest first and empties the queue', async () => {
    state().enqueue({ ...payload(1), clientSaleId: 'a' });
    state().enqueue({ ...payload(2), clientSaleId: 'b' });
    salesApi.checkout.mockResolvedValue({ data: {} });
    await state().sync();
    expect(salesApi.checkout.mock.calls.map((c) => c[0].clientSaleId)).toEqual(['a', 'b']);
    expect(state().queue).toEqual([]);
    expect(state().syncing).toBe(false);
  });

  it('a network failure keeps the sale, stops the run and leaves later sales untried', async () => {
    state().enqueue({ ...payload(1), clientSaleId: 'a' });
    state().enqueue({ ...payload(2), clientSaleId: 'b' });
    salesApi.checkout.mockRejectedValue(new Error('Network Error'));
    await state().sync();
    expect(salesApi.checkout).toHaveBeenCalledTimes(1);
    expect(state().queue.map((e) => e.clientSaleId)).toEqual(['a', 'b']);
    expect(state().queue.every((e) => !e.failed)).toBe(true);
    expect(state().queue[0].attempts).toBe(1);
    expect(state().syncing).toBe(false);
    expect(state().lastSyncError).not.toBe('');
  });

  it('a 5xx, a timeout and a rate limit are all retried later, not marked failed', async () => {
    for (const status of [500, 503, 408, 429]) {
      useOfflineQueue.setState({ queue: [] });
      state().enqueue({ ...payload(), clientSaleId: `s${status}` });
      salesApi.checkout.mockRejectedValueOnce(httpError(status));
      await state().sync();
      expect(state().queue[0].failed).toBeFalsy();
    }
  });

  it('a 4xx marks that sale failed, keeps it, and carries on with the next one', async () => {
    state().enqueue({ ...payload(1), clientSaleId: 'bad' });
    state().enqueue({ ...payload(2), clientSaleId: 'good' });
    salesApi.checkout
      .mockRejectedValueOnce(httpError(400, 'Not enough stock for Tee.'))
      .mockResolvedValueOnce({ data: {} });
    await state().sync();
    expect(state().queue).toHaveLength(1);
    expect(state().queue[0]).toMatchObject({ clientSaleId: 'bad', failed: true, lastError: 'Not enough stock for Tee.' });
    expect(state().failedCount()).toBe(1);
    expect(state().pendingCount()).toBe(0);
  });

  it('never discards anything by itself; only discard() removes a rejected sale', async () => {
    state().enqueue({ ...payload(), clientSaleId: 'bad' });
    salesApi.checkout.mockRejectedValue(httpError(422));
    await state().sync();
    await state().sync();
    expect(state().queue).toHaveLength(1);
    state().discard('bad');
    expect(state().queue).toEqual([]);
  });

  it('does nothing when the queue is empty or a sync is already running', async () => {
    await state().sync();
    expect(salesApi.checkout).not.toHaveBeenCalled();
    state().enqueue(payload());
    useOfflineQueue.setState({ syncing: true });
    await state().sync();
    expect(salesApi.checkout).not.toHaveBeenCalled();
  });
});

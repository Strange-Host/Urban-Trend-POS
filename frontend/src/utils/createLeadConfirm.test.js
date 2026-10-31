import { describe, it, expect, vi } from 'vitest';
import { createLeadWithConfirm } from './createLeadConfirm';

const possible = { response: { status: 409, data: { error: { code: 'POSSIBLE_DUPLICATE_LEAD' }, details: { possibleDuplicates: [{ id: 3, name: 'Jane Wanjiru' }] } } } };
const phoneDup = { response: { status: 409, data: { error: { code: 'CONFLICT', message: 'A lead with this phone number already exists.' }, details: { existingLeadId: 3 } } } };

describe('createLeadWithConfirm', () => {
  it('returns the lead straight away when nothing clashes', async () => {
    const create = vi.fn().mockResolvedValue({ id: 1 });
    const confirm = vi.fn();
    expect(await createLeadWithConfirm({ create, payload: { name: 'A B' }, confirm })).toEqual({ id: 1 });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks, then sends the lead again with the flag when the answer is yes', async () => {
    const create = vi.fn().mockRejectedValueOnce(possible).mockResolvedValueOnce({ id: 2 });
    const confirm = vi.fn().mockResolvedValue(true);
    const out = await createLeadWithConfirm({ create, payload: { name: 'Jane Wanjiru', phone: '0722' }, confirm });
    expect(out).toEqual({ id: 2 });
    expect(confirm.mock.calls[0][0].message).toContain('Jane Wanjiru');
    expect(create).toHaveBeenLastCalledWith({ name: 'Jane Wanjiru', phone: '0722', allow_possible_duplicate: true });
  });

  it('creates nothing when the answer is no', async () => {
    const create = vi.fn().mockRejectedValue(possible);
    const out = await createLeadWithConfirm({ create, payload: { name: 'Jane Wanjiru' }, confirm: vi.fn().mockResolvedValue(false) });
    expect(out).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not offer to override a phone or email match', async () => {
    const create = vi.fn().mockRejectedValue(phoneDup);
    const confirm = vi.fn();
    await expect(createLeadWithConfirm({ create, payload: {}, confirm })).rejects.toBe(phoneDup);
    expect(confirm).not.toHaveBeenCalled();
  });
});

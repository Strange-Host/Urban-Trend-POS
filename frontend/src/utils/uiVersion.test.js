import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  UI_FLAG_KEY, getUiVersion, setUiVersion, subscribeUiVersion, applyUiFlagFromUrl,
} from './uiVersion';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.ui;
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.restoreAllMocks());

describe('getUiVersion', () => {
  it('is v1 when nothing has been saved', () => {
    expect(getUiVersion()).toBe('v1');
  });

  it('is v2 only when v2 is saved', () => {
    localStorage.setItem(UI_FLAG_KEY, 'v2');
    expect(getUiVersion()).toBe('v2');
  });

  it('treats any unrecognised saved value as v1', () => {
    for (const junk of ['v3', 'V2', 'true', '1', '']) {
      localStorage.setItem(UI_FLAG_KEY, junk);
      expect(getUiVersion()).toBe('v1');
    }
  });

  it('falls back to v1 when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(getUiVersion()).toBe('v1');
  });
});

describe('setUiVersion', () => {
  it('saves v2 and clears the key for v1', () => {
    setUiVersion('v2');
    expect(localStorage.getItem(UI_FLAG_KEY)).toBe('v2');
    setUiVersion('v1');
    expect(localStorage.getItem(UI_FLAG_KEY)).toBeNull();
  });

  it('does not throw when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => setUiVersion('v2')).not.toThrow();
    expect(getUiVersion()).toBe('v1');
  });

  it('mirrors the version onto the document element', () => {
    setUiVersion('v2');
    expect(document.documentElement.dataset.ui).toBe('v2');
    setUiVersion('v1');
    expect(document.documentElement.dataset.ui).toBe('v1');
  });

  it('notifies subscribers, and stops after they unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeUiVersion(fn);
    setUiVersion('v2');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    setUiVersion('v1');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('subscribeUiVersion', () => {
  it('notifies when another tab changes the flag', () => {
    const fn = vi.fn();
    const off = subscribeUiVersion(fn);
    window.dispatchEvent(new StorageEvent('storage', { key: UI_FLAG_KEY }));
    expect(fn).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new StorageEvent('storage', { key: 'some_other_key' }));
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('applyUiFlagFromUrl', () => {
  it('turns v2 on from the address and removes the parameter, keeping the rest of the URL', () => {
    window.history.replaceState(null, '', '/orders?tab=open&ut_ui=v2#top');
    applyUiFlagFromUrl();
    expect(getUiVersion()).toBe('v2');
    expect(window.location.pathname + window.location.search + window.location.hash).toBe('/orders?tab=open#top');
  });

  it('turns v2 back off with ?ut_ui=v1', () => {
    setUiVersion('v2');
    window.history.replaceState(null, '', '/?ut_ui=v1');
    applyUiFlagFromUrl();
    expect(getUiVersion()).toBe('v1');
    expect(localStorage.getItem(UI_FLAG_KEY)).toBeNull();
  });

  it('ignores an unrecognised value without changing the saved flag, but still strips it', () => {
    setUiVersion('v2');
    window.history.replaceState(null, '', '/?ut_ui=banana');
    applyUiFlagFromUrl();
    expect(getUiVersion()).toBe('v2');
    expect(window.location.search).toBe('');
  });

  it('leaves everything alone when the parameter is absent', () => {
    window.history.replaceState(null, '', '/sales?page=2');
    applyUiFlagFromUrl();
    expect(getUiVersion()).toBe('v1');
    expect(window.location.search).toBe('?page=2');
    expect(document.documentElement.dataset.ui).toBe('v1');
  });
});

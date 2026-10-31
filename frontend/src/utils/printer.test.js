import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadPrinter, savePrinter, DEFAULT_PRINTER, sendToBridge, printDirect, printTest, printReceiptDirectIfEnabled } from './printer';
import client from '../api/client';

vi.mock('../api/client', () => ({ default: { get: vi.fn() } }));

const okFetch = () => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });

beforeEach(() => { client.get.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('printer settings', () => {
  it('start switched off, and survive bad stored data', () => {
    expect(loadPrinter()).toEqual(DEFAULT_PRINTER);
    expect(loadPrinter().enabled).toBe(false);
    localStorage.setItem('ut_printer', '{not json');
    expect(loadPrinter()).toEqual(DEFAULT_PRINTER);
  });

  it('are saved per browser, tidied (paper width, trailing slash), and read back', () => {
    savePrinter({ ...DEFAULT_PRINTER, enabled: true, bridgeUrl: ' http://127.0.0.1:9101/ ', cols: '32', autoPrint: true });
    expect(loadPrinter()).toMatchObject({ enabled: true, bridgeUrl: 'http://127.0.0.1:9101', cols: 32, autoPrint: true });
    savePrinter({ ...DEFAULT_PRINTER, cols: 99 });
    expect(loadPrinter().cols).toBe(48);
  });
});

describe('printing through the bridge', () => {
  it('posts the receipt bytes the server made, asking for the cut, width and cash-only drawer', async () => {
    const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock);
    client.get.mockResolvedValue({ data: new Uint8Array([27, 64, 65]).buffer });
    await printDirect('sale', 12, { ...DEFAULT_PRINTER, enabled: true, cols: 32 });
    expect(client.get).toHaveBeenCalledWith('/sales/12/receipt.escpos', { params: { cols: 32, drawer: 'cash' }, responseType: 'arraybuffer' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9101/print');
    expect(Array.from(init.body)).toEqual([27, 64, 65]);
  });

  it('skips the cut and the drawer when those are off, and never asks for a drawer on an order', async () => {
    vi.stubGlobal('fetch', okFetch());
    client.get.mockResolvedValue({ data: new ArrayBuffer(1) });
    await printDirect('order', 3, { ...DEFAULT_PRINTER, cut: false, drawerOnCash: true });
    expect(client.get).toHaveBeenCalledWith('/orders/3/receipt.escpos', { params: { cols: 48, cut: 0 }, responseType: 'arraybuffer' });
    await printDirect('sale', 3, { ...DEFAULT_PRINTER, drawerOnCash: false });
    expect(client.get.mock.calls[1][1].params).toEqual({ cols: 48 });
  });

  it('explains an unreachable bridge, and passes on the bridge\'s own error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(sendToBridge(new Uint8Array(1), DEFAULT_PRINTER)).rejects.toThrow(/Could not reach the print bridge at http:\/\/127\.0\.0\.1:9101/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => ({ error: 'Could not reach the printer: ECONNREFUSED' }) }));
    await expect(sendToBridge(new Uint8Array(1), DEFAULT_PRINTER)).rejects.toThrow(/Could not reach the printer: ECONNREFUSED/);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => { throw new Error('x'); } }));
    await expect(sendToBridge(new Uint8Array(1), DEFAULT_PRINTER)).rejects.toThrow(/answered 403/);
  });

  it('the test print is init + text + cut, built without the server', async () => {
    const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock);
    await printTest({ ...DEFAULT_PRINTER, cut: true });
    const bytes = Array.from(fetchMock.mock.calls[0][1].body);
    expect(bytes.slice(0, 2)).toEqual([0x1b, 0x40]);
    expect(bytes.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00]);
    expect(client.get).not.toHaveBeenCalled();
  });
});

describe('printReceiptDirectIfEnabled', () => {
  it('does nothing (so the caller uses the print dialog) while direct printing is off', async () => {
    const fetchMock = okFetch(); vi.stubGlobal('fetch', fetchMock);
    expect(await printReceiptDirectIfEnabled('sale', 1, {})).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
  });

  it('prints directly and reports it when on', async () => {
    savePrinter({ ...DEFAULT_PRINTER, enabled: true });
    vi.stubGlobal('fetch', okFetch());
    client.get.mockResolvedValue({ data: new ArrayBuffer(2) });
    expect(await printReceiptDirectIfEnabled('sale', 1, {})).toBe(true);
  });

  it('falls back to the print dialog, and says why, when the bridge is down', async () => {
    savePrinter({ ...DEFAULT_PRINTER, enabled: true });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    client.get.mockResolvedValue({ data: new ArrayBuffer(2) });
    const toast = { info: vi.fn() };
    expect(await printReceiptDirectIfEnabled('sale', 1, toast)).toBe(false);
    expect(toast.info).toHaveBeenCalledWith(expect.stringMatching(/Using the print dialog instead/));
  });
});

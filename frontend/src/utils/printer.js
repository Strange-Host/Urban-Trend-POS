import client from '../api/client';

// Direct thermal printing through the print bridge (print-bridge/README.md). Per till, so the settings live in this
// browser. Everything here is optional: with it switched off, or when the bridge cannot be reached, the normal browser
// print dialog is used, so a receipt is never lost.

const KEY = 'ut_printer';

export const DEFAULT_PRINTER = {
  enabled: false,                    // print directly instead of opening the print dialog
  bridgeUrl: 'http://127.0.0.1:9101',
  cols: 48,                          // 48 = 80 mm paper, 32 = 58 mm
  cut: true,
  drawerOnCash: true,                // open the cash drawer when a sale includes cash
  autoPrint: false,                  // print as soon as a sale is charged
};

export function loadPrinter() {
  try {
    return { ...DEFAULT_PRINTER, ...(JSON.parse(localStorage.getItem(KEY) || '{}') || {}) };
  } catch {
    return { ...DEFAULT_PRINTER };
  }
}

export function savePrinter(settings) {
  const clean = { ...DEFAULT_PRINTER, ...settings, cols: Number(settings.cols) === 32 ? 32 : 48, bridgeUrl: String(settings.bridgeUrl || DEFAULT_PRINTER.bridgeUrl).trim().replace(/\/$/, '') };
  try { localStorage.setItem(KEY, JSON.stringify(clean)); } catch { /* storage blocked: settings last until reload */ }
  return clean;
}

export const bridgeMessage = (err) => err?.message || 'The print bridge did not answer.';

/** Sends raw ESC/POS bytes to the bridge. Throws an Error with a readable message on any failure. */
export async function sendToBridge(bytes, settings = loadPrinter()) {
  let res;
  try {
    res = await fetch(`${settings.bridgeUrl}/print`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes });
  } catch (err) {
    throw new Error(`Could not reach the print bridge at ${settings.bridgeUrl}. Is it running?`, { cause: err });
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch { /* not JSON */ }
    throw new Error(detail || `The print bridge answered ${res.status}.`);
  }
}

export async function bridgeStatus(settings = loadPrinter()) {
  try {
    const res = await fetch(`${settings.bridgeUrl}/status`);
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return (await res.json()).printer;
  } catch (err) {
    throw new Error(`Could not reach the print bridge at ${settings.bridgeUrl}. Is it running?`, { cause: err });
  }
}

/** Fetches the receipt as ESC/POS bytes and prints it. kind: 'sale' | 'order'. */
export async function printDirect(kind, id, settings = loadPrinter()) {
  const params = { cols: settings.cols, ...(settings.cut ? {} : { cut: 0 }), ...(settings.drawerOnCash && kind === 'sale' ? { drawer: 'cash' } : {}) };
  const { data } = await client.get(`/${kind === 'sale' ? 'sales' : 'orders'}/${id}/receipt.escpos`, { params, responseType: 'arraybuffer' });
  await sendToBridge(new Uint8Array(data), settings);
}

/** Opens the cash drawer without a sale. */
export async function openDrawer(settings = loadPrinter()) {
  const { data } = await client.get('/sales/drawer.escpos', { responseType: 'arraybuffer' });
  await sendToBridge(new Uint8Array(data), settings);
}

/** A few lines and a cut, to prove the printer is wired up. Built here so it works without a sale. */
export async function printTest(settings = loadPrinter()) {
  const text = new TextEncoder().encode('\nPrinter test\nIf you can read this, direct printing works.\n\n\n\n');
  const init = [0x1b, 0x40];
  const cut = settings.cut ? [0x1d, 0x56, 0x42, 0x00] : [];
  await sendToBridge(new Uint8Array([...init, ...text, ...cut]), settings);
}

/**
 * Prints a receipt the way this till is set up: straight to the thermal printer when that is on, otherwise (or if the
 * bridge can't be reached) the caller falls back to the browser's print dialog. Returns true when it went to the printer.
 */
export async function printReceiptDirectIfEnabled(kind, id, toast) {
  const settings = loadPrinter();
  if (!settings.enabled) return false;
  try {
    await printDirect(kind, id, settings);
    return true;
  } catch (err) {
    toast?.info?.(`${bridgeMessage(err)} Using the print dialog instead.`);
    return false;
  }
}


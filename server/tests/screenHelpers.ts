import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const code = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/**
 * Loads the real staff screens (public/app.js) into a simulated browser pointed at a running server, logged in with `token`.
 * Everything the person would do (visit a page, fill a form, press a button) is done through the page itself.
 */
export async function browser(base: string, token: string | null) {
  const dom = new JSDOM(`<!doctype html><body><div id="app"></div><dialog id="dlg"></dialog></body>`, { url: `${base}/app/`, runScripts: 'outside-only', pretendToBeVisual: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w: any = dom.window;
  if (token) w.sessionStorage.setItem('ut_token', token);
  w.fetch = ((url: string, init?: RequestInit) => fetch(`${base}${url}`, init)) as typeof fetch;
  w.crypto = globalThis.crypto;
  const dialogProto = w.HTMLDialogElement.prototype as Record<string, unknown>;
  dialogProto.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
  // A real browser fires "close" a moment AFTER close() returns, so the button's own answer is recorded first.
  dialogProto.close = function (this: HTMLDialogElement) { this.removeAttribute('open'); setTimeout(() => this.dispatchEvent(new w.Event('close')), 0); };
  w.Element.prototype.scrollIntoView = () => undefined;
  w.alert = (m: string) => { throw new Error(`alert: ${m}`); };
  const errors: string[] = [];
  w.addEventListener('error', (e: ErrorEvent) => errors.push(String(e.error?.message ?? e.message)));
  w.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => errors.push(String(e.reason)));
  w.eval(code);

  const doc: Document = w.document;
  const text = () => doc.getElementById('app')!.textContent ?? '';
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (pred: () => boolean, what: string) => {
    for (let i = 0; i < 150; i++) { if (pred()) return; await sleep(30); }
    throw new Error(`timed out waiting for ${what}. Page says: ${text().slice(0, 400)}`);
  };
  const visit = async (hash: string, expectText: string) => {
    w.location.hash = hash;
    await waitFor(() => text().includes(expectText) && !doc.querySelector('.msg.err'), `"${expectText}" at ${hash}`);
  };
  const noticeText = () => doc.getElementById('notice')?.textContent ?? '';
  /** The form on the page that has a submit button with exactly this label. */
  const formWith = (button: string): HTMLFormElement => {
    const f = [...doc.querySelectorAll('form')].find((x) => [...x.querySelectorAll('button')].some((b) => b.textContent === button));
    if (!f) throw new Error(`no form with a "${button}" button. Page says: ${text().slice(0, 300)}`);
    return f;
  };
  const set = (f: ParentNode, name: string, value: string) => {
    const el = f.querySelector(`[name=${name}]`) as HTMLInputElement | HTMLSelectElement | null;
    if (!el) throw new Error(`no field "${name}"`);
    if (el instanceof w.HTMLSelectElement) { el.value = value; if (el.value !== value) throw new Error(`"${value}" is not an option of ${name}`); } else el.value = value;
  };
  const check = (f: ParentNode, name: string, on: boolean) => { (f.querySelector(`[name=${name}]`) as HTMLInputElement).checked = on; };
  const submit = (f: HTMLFormElement) => f.dispatchEvent(new w.Event('submit', { cancelable: true }));
  const change = (el: Element) => el.dispatchEvent(new w.Event('change', { bubbles: true }));
  const click = (btn: Element) => (btn as HTMLButtonElement).click();
  /** Presses a button inside the confirmation box that has opened. */
  const answer = async (button: string) => {
    const dlg = doc.getElementById('dlg') as HTMLDialogElement;
    await waitFor(() => dlg.hasAttribute('open'), 'a confirmation box');
    const b = [...dlg.querySelectorAll('button')].find((x) => x.textContent === button);
    if (!b) throw new Error(`no "${button}" button in the box: ${dlg.textContent}`);
    b.click();
  };
  const buttonLabels = () => [...doc.querySelectorAll('button')].map((b) => b.textContent);
  // The app draws its first screen once on load and again when it sets the address, so let that settle: otherwise a test
  // can grab a button from the first drawing just before the second one replaces it.
  if (token) await waitFor(() => !!doc.querySelector('header nav'), 'the first screen');
  return { w, dom, doc, text, noticeText, visit, waitFor, formWith, set, check, submit, change, click, answer, errors, sleep, buttonLabels };
}

/** Polls until `read()` returns something `ok` accepts: the server may still be finishing the request the screen made. */
export async function eventually<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 100; i++) { last = await read(); if (ok(last)) return last; await new Promise((r) => setTimeout(r, 30)); }
  throw new Error(`timed out waiting for ${what}; last saw ${JSON.stringify(last)}`);
}

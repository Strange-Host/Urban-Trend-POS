#!/usr/bin/env node
// Urban Trends print bridge. Runs on the till computer, next to the thermal printer. The POS page (in the browser)
// fetches ready-made ESC/POS bytes from the server and posts them here; this passes them to the printer, which then
// prints, cuts the paper and (optionally) opens the cash drawer. No dependencies: only Node 18+.
//
//   PRINTER_HOST=192.168.1.50 node print-bridge/bridge.js        network printer (raw port 9100)
//   PRINTER_DEVICE=/dev/usb/lp0 node print-bridge/bridge.js      USB / serial / shared printer, as a file path
//   ALLOW_ORIGIN=https://pos.example.com                         which POS site may print (comma separated)
//
// See print-bridge/README.md.
const http = require('http');
const net = require('net');
const fs = require('fs');

const MAX_BYTES = 256 * 1024; // a receipt is a few KB; anything bigger is not a receipt

function sendToPrinter(bytes, { host, port, device, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    if (device) {
      fs.writeFile(device, bytes, (err) => (err ? reject(err) : resolve()));
      return;
    }
    const socket = net.createConnection({ host, port });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(timeoutMs, () => fail(new Error('The printer did not answer in time.')));
    socket.once('error', fail);
    socket.once('connect', () => socket.end(bytes, () => resolve()));
  });
}

/**
 * @param {{ host?: string, port?: number, device?: string, allowOrigins: string[], send?: Function }} cfg
 *   send: replaceable for tests; defaults to writing to the real printer.
 */
function createBridge(cfg) {
  const allowed = new Set((cfg.allowOrigins || []).map((o) => o.trim().replace(/\/$/, '')).filter(Boolean));
  const send = cfg.send || ((bytes) => sendToPrinter(bytes, cfg));

  return http.createServer((req, res) => {
    const origin = req.headers.origin;
    const reply = (status, body) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        ...(origin && allowed.has(origin) ? {
          'Access-Control-Allow-Origin': origin, Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Allow-Private-Network': 'true',
        } : {}),
      });
      res.end(JSON.stringify(body));
    };

    // A page on any other site must not be able to print or open the drawer. Requests with no Origin (curl, a local
    // script on this machine) are fine: they already have access to the computer.
    if (origin && !allowed.has(origin)) return reply(403, { ok: false, error: 'This site is not allowed to print here.' });

    if (req.method === 'OPTIONS') { res.writeHead(204, origin && allowed.has(origin) ? {
      'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Max-Age': '600',
    } : {}); return res.end(); }

    if (req.method === 'GET' && req.url === '/status') return reply(200, { ok: true, printer: cfg.device || `${cfg.host}:${cfg.port}` });

    if (req.method === 'POST' && req.url === '/print') {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BYTES) { tooBig = true; req.destroy(); return; }
        chunks.push(c);
      });
      req.on('close', () => { if (tooBig && !res.writableEnded) reply(413, { ok: false, error: 'That is too large to be a receipt.' }); });
      req.on('end', async () => {
        const bytes = Buffer.concat(chunks);
        if (bytes.length === 0) return reply(400, { ok: false, error: 'Nothing to print.' });
        try {
          await send(bytes);
          reply(200, { ok: true, bytes: bytes.length });
        } catch (err) {
          reply(502, { ok: false, error: `Could not reach the printer: ${err.message}` });
        }
      });
      return undefined;
    }

    return reply(404, { ok: false, error: 'Not found.' });
  });
}

module.exports = { createBridge, sendToPrinter };

if (require.main === module) {
  const cfg = {
    host: process.env.PRINTER_HOST,
    port: Number(process.env.PRINTER_PORT) || 9100,
    device: process.env.PRINTER_DEVICE,
    allowOrigins: (process.env.ALLOW_ORIGIN || 'http://localhost:5173').split(','),
  };
  if (!cfg.host && !cfg.device) {
    console.error('Set PRINTER_HOST (network printer) or PRINTER_DEVICE (USB/serial/shared printer path). See print-bridge/README.md.');
    process.exit(1);
  }
  const port = Number(process.env.BRIDGE_PORT) || 9101;
  createBridge(cfg).listen(port, '127.0.0.1', () => {
    console.log(`Print bridge listening on http://127.0.0.1:${port} -> ${cfg.device || `${cfg.host}:${cfg.port}`}`);
    console.log(`Allowed sites: ${cfg.allowOrigins.join(', ')}`);
  });
}

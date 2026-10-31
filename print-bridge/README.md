# Print bridge (thermal printer, paper cut, cash drawer)

A browser cannot talk to a receipt printer directly, so the default **Print** button opens the normal print dialog
(the receipt is laid out for an 80 mm roll). That works with any printer but cannot cut the paper or open the cash
drawer by itself, and shows a dialog every time.

If you want one-tap printing, paper cut and drawer pop, run this small program on the till computer.

## How it works

1. The POS page asks the server for the receipt as **ESC/POS** bytes (`GET /api/sales/:id/receipt.escpos`).
2. It posts those bytes to this bridge on the same computer (`http://127.0.0.1:9101/print`).
3. The bridge hands them to the printer. If anything goes wrong the page falls back to the normal print dialog,
   so a sale is never left without a receipt.

## Run it (Node 18 or newer, nothing to install)

```
# Network (Ethernet/Wi-Fi) printer, the usual raw port 9100:
PRINTER_HOST=192.168.1.50 ALLOW_ORIGIN=https://your-pos-site node print-bridge/bridge.js

# USB or serial printer on Linux:
PRINTER_DEVICE=/dev/usb/lp0 ALLOW_ORIGIN=https://your-pos-site node print-bridge/bridge.js

# Windows: share the printer (e.g. as "ThermalPrinter"), then
set PRINTER_DEVICE=\\localhost\ThermalPrinter
set ALLOW_ORIGIN=https://your-pos-site
node print-bridge\bridge.js
```

`ALLOW_ORIGIN` is the address of the POS site as shown in the browser (comma separate several). Only those sites may
print; any other web page is refused. The bridge listens on this computer only.

Then, in the POS: **Terminal > Printer** (button under the cart), tick **Print directly**, and press **Test**.

## Settings, per till (stored in that browser)

| Setting | Meaning |
|---|---|
| Bridge address | normally `http://127.0.0.1:9101` |
| Paper width | 80 mm = 48 characters per line, 58 mm = 32 |
| Cut paper | cut after each receipt |
| Open cash drawer on cash sales | the drawer wired to the printer's RJ11 port opens when a sale includes cash |

## Not covered

Printers that only speak a vendor's own language (not ESC/POS) and Bluetooth printers. Those keep using the normal
print dialog. The bridge could not be tested against real hardware in development; use **Test** on the first install.

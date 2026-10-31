import { useState } from 'react';
import { downloadFile, getErrorMessage } from '../api/client';
import { useToast } from '../context/UIContext';

/** Downloads the PDF invoice for an order or a till sale (kind = "order" | "sale"). */
export default function InvoiceButton({ kind, id, label = 'Invoice', className = '' }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      await downloadFile(`/${kind === 'order' ? 'orders' : 'sales'}/${id}/invoice.pdf`, undefined, `invoice_${id}.pdf`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not download the invoice.'));
    } finally {
      setBusy(false);
    }
  }
  return <button type="button" onClick={download} disabled={busy} className={className}>{busy ? 'Preparing…' : label}</button>;
}

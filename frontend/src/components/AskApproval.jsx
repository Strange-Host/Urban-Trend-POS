import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { approvalsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useToast, useDialog } from '../context/UIContext';

const COPY = {
  void_sale: {
    title: 'Ask a manager to void this sale',
    message: 'A manager has to approve it. The sale stays as it is until they do.',
    sent: 'Request sent. A manager will approve or reject it.',
    waiting: 'Void requested',
  },
  refund_payment: {
    title: 'Ask for this payment to be refunded',
    message: 'Someone with refund rights has to approve it. The payment stays as it is until they do.',
    sent: 'Request sent. It will be approved or rejected.',
    waiting: 'Refund requested',
  },
};

/**
 * <AskApproval kind="void_sale" targetId={sale.id} pendingId={sale.pending_void_request_id} label="Request void" />
 *
 * For someone who may not void / refund on their own: asks for a reason, files the request, and from then on shows
 * "requested" (linking to the Approvals page) instead of a button, so it cannot be filed twice.
 * `invalidateKeys` are the react-query keys to refresh afterwards (the list the button sits in).
 */
export default function AskApproval({ kind, targetId, pendingId, label, className = '', invalidateKeys = [] }) {
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const copy = COPY[kind];

  if (pendingId) {
    return <Link to="/approvals" className="text-xs text-text-muted underline decoration-dotted" title="Waiting for a manager">{copy.waiting}</Link>;
  }

  async function handleClick() {
    const reason = await dialog.prompt({
      title: copy.title, message: copy.message, placeholder: 'Why? (e.g. wrong item scanned)', required: true, confirmLabel: 'Send request',
    });
    if (!reason || !reason.trim()) return;
    try {
      await approvalsApi.create({ kind, ...(kind === 'void_sale' ? { sale_id: targetId } : { payment_id: targetId }), reason: reason.trim() });
      toast.success(copy.sent);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not send the request.'));
    }
    [...invalidateKeys, ['approvals']].forEach((queryKey) => queryClient.invalidateQueries({ queryKey }));
  }

  return (
    <button type="button" onClick={handleClick} className={className || 'text-xs text-danger hover:opacity-70'}>
      {label}
    </button>
  );
}

import { useState } from 'react';
import { useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { approvalsApi } from '../api/endpoints';
import { getErrorMessage } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useToast, useDialog } from '../context/UIContext';
import TabBar from '../components/TabBar';
import Pager, { usePager } from '../components/Pager';
import { StatusPill } from '../components/DataUI';

// Void / refund requests. A cashier sees the ones they filed (and what happened to them); a manager sees the store's and
// approves or rejects. Approving runs the void / refund, so it is confirmed first and the server asks for the password
// again, the same as the direct Void and Refund buttons do.

const STATUS = {
  pending: { tone: 'accent', label: 'Waiting' },
  approved: { tone: 'success', label: 'Approved' },
  rejected: { tone: 'danger', label: 'Rejected' },
  cancelled: { tone: 'neutral', label: 'Withdrawn' },
  failed: { tone: 'danger', label: 'Could not run' },
};

const kes = (cents) => ((Number(cents) || 0) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// SQLite datetimes are UTC with no zone marker.
function when(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(`${sqliteUtc.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
}

function describe(r) {
  if (r.kind === 'void_sale') {
    return { title: `Void sale ${r.target_ref}`, detail: r.sale_payment_method ? `Paid by ${String(r.sale_payment_method).replace('_', ' ')}` : '' };
  }
  const against = r.payment_sale_id ? `Sale S-${r.payment_sale_id}` : r.payment_order_id ? `Order #${r.payment_order_id}` : '';
  return { title: `Refund ${r.target_ref}`, detail: [r.payment_method && String(r.payment_method).replace('_', ' '), against].filter(Boolean).join(' · ') };
}

const CONSEQUENCE = {
  void_sale: 'The sale will be marked void and its items put back in stock.',
  refund_payment: 'The payment will be marked refunded.',
};

export default function Approvals() {
  const { user, can } = useAuth();
  const toast = useToast();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState('pending');
  const reviewer = can('approvals.review');

  const pager = usePager(25);
  const { data, isLoading } = useQuery({
    queryKey: ['approvals', tab, { page: pager.page, size: pager.pageSize }],
    queryFn: () => approvalsApi.list({ ...pager.params, status: tab }).then((r) => r.data),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
  const rows = data?.data || [];
  const waiting = data?.pending || 0;

  // A decision can change a sale, its stock, a payment and the bell, so refresh all of them.
  function refresh() {
    ['approvals', 'sales', 'payments', 'products', 'notifications'].forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
  }

  async function handleApprove(r) {
    const { title } = describe(r);
    const ok = await dialog.confirm({
      title: `Approve: ${title}?`,
      message: `${kes(r.amount)} KES · asked by ${r.requested_by_name}\nReason: ${r.reason}\n\n${CONSEQUENCE[r.kind]}`,
      confirmLabel: r.kind === 'void_sale' ? 'Approve and void' : 'Approve and refund',
      danger: true,
    });
    if (!ok) return;
    try {
      await approvalsApi.approve(r.id);
      toast.success(`${title}: done.`);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not approve this request.'));
    }
    refresh();
  }

  async function handleReject(r) {
    const note = await dialog.prompt({
      title: `Reject: ${describe(r).title}`,
      message: `Tell ${r.requested_by_name} why, so they know what to do next.`,
      placeholder: 'Reason', required: true, confirmLabel: 'Reject',
    });
    if (!note || !note.trim()) return;
    try {
      await approvalsApi.reject(r.id, note.trim());
      toast.success('Request rejected.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not reject this request.'));
    }
    refresh();
  }

  async function handleCancel(r) {
    if (!(await dialog.confirm({ message: 'Withdraw this request?', confirmLabel: 'Withdraw' }))) return;
    try {
      await approvalsApi.cancel(r.id);
      toast.success('Request withdrawn.');
    } catch (err) {
      toast.error(getErrorMessage(err, 'Could not withdraw this request.'));
    }
    refresh();
  }

  const tabs = [
    { key: 'pending', label: waiting ? `Waiting (${waiting})` : 'Waiting' },
    { key: 'closed', label: 'History' },
  ];

  return (
    <div className="p-4 md:p-8 max-w-6xl">
      <h1 className="font-display font-700 text-2xl mb-1">Approvals</h1>
      <p className="text-text-muted text-sm mb-4">
        {reviewer
          ? 'Void and refund requests from the team. Nothing changes until you approve it.'
          : 'Your void and refund requests. A manager approves or rejects each one; you are told when they do.'}
      </p>

      <TabBar tabs={tabs} active={tab} onChange={(k) => { setTab(k); pager.reset(); }} variant="filter" className="mb-6" />

      <div className="bg-surface border border-line rounded-xl overflow-hidden">
        <div className="scroll-x">
          <table className="stack-sm w-full text-sm min-w-[760px]">
            <thead>
              <tr className="border-b border-line text-left text-text-muted">
                <th className="px-4 py-3 font-medium">Request</th>
                <th className="px-4 py-3 font-medium text-right">Amount</th>
                {reviewer && <th className="px-4 py-3 font-medium">Asked by</th>}
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">{tab === 'pending' ? 'Asked' : 'Outcome'}</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={6} className="px-4 py-8 text-center text-text-muted">Loading…</td></tr>}
              {!isLoading && rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-text-muted">
                    {tab === 'pending'
                      ? (reviewer ? 'Nothing is waiting for approval.' : 'You have no requests waiting.')
                      : 'No decided requests yet.'}
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const d = describe(r);
                const own = r.requested_by === user?.id;
                const st = STATUS[r.status] || STATUS.pending;
                return (
                  <tr key={r.id} className="border-b border-line last:border-0 align-top">
                    <td className="px-4 py-3">
                      <div className="font-medium">{d.title}</div>
                      {d.detail && <div className="text-xs text-text-muted capitalize">{d.detail}</div>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono whitespace-nowrap">{kes(r.amount)}</td>
                    {reviewer && <td className="px-4 py-3">{r.requested_by_name}</td>}
                    <td className="px-4 py-3 max-w-xs break-words">{r.reason}</td>
                    <td className="px-4 py-3">
                      {r.status === 'pending' ? (
                        <span className="text-xs text-text-muted">{when(r.requested_at)}</span>
                      ) : (
                        <div>
                          <StatusPill tone={st.tone}>{st.label}</StatusPill>
                          <div className="text-xs text-text-muted mt-1">
                            {r.reviewed_by_name ? `${r.reviewed_by_name} · ` : ''}{when(r.reviewed_at)}
                          </div>
                          {r.review_note && <div className="text-xs mt-0.5 break-words">{r.review_note}</div>}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {r.status === 'pending' && reviewer && !own && (
                        <>
                          <button type="button" onClick={() => handleApprove(r)} className="px-3 py-1.5 rounded-lg bg-ink text-white text-xs font-medium hover:bg-ink-soft mr-2">Approve</button>
                          <button type="button" onClick={() => handleReject(r)} className="px-3 py-1.5 rounded-lg border border-line text-xs font-medium hover:border-text-muted">Reject</button>
                        </>
                      )}
                      {r.status === 'pending' && own && (
                        <>
                          {reviewer && <span className="text-xs text-text-muted mr-3">Needs another manager</span>}
                          <button type="button" onClick={() => handleCancel(r)} className="text-xs text-text-muted hover:text-text underline">Withdraw</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pager pager={pager} data={data} noun="requests" />
      </div>
    </div>
  );
}

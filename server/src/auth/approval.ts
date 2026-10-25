import type { Pool } from '../db/pool.js';
import { HttpError } from '../errors.js';
import { audit } from '../pos/audit.js';
import { userCan } from './access.js';
import { verifyCredentials } from './service.js';
import type { AuthUser } from './types.js';

export interface ApprovalInput { username: string; password: string }
export interface Approver { approver: string; approverRole: string }

/**
 * A second person approves something by entering THEIR OWN username and password on this device (the manager override).
 * The approver must be allowed to approve, and cannot be the person who asked. The approval is audited.
 */
export async function approverFrom(pool: Pool, approval: ApprovalInput | undefined, requester: AuthUser, what: string): Promise<Approver> {
  if (!approval) throw new HttpError(403, 'APPROVAL_REQUIRED', `A manager must approve ${what}: they enter their own username and password.`);
  const u = await verifyCredentials(pool, approval.username, approval.password);
  if (u.username === requester.username) throw new HttpError(403, 'APPROVER_IS_REQUESTER', 'Someone other than you must approve this.');
  if (!(await userCan(pool, u, 'pos.approve'))) throw new HttpError(403, 'APPROVER_NOT_ALLOWED', `A ${u.role} cannot approve this.`);
  await audit(pool, { actor: u.username, role: u.role, action: 'approval_given', entityType: 'approval', details: { what, for: requester.username } });
  return { approver: u.username, approverRole: u.role };
}

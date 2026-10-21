import type { Pool } from '../db/pool.js';
import type { Queryable } from '../db/tx.js';
import { HttpError } from '../errors.js';
import { assertPeriodOpen } from './profiles.js';
import { isDateString, shopDate } from './time.js';

export interface AttendanceRecord {
  staffKey: string;
  workDate: string;
  clockInAt: Date | null;
  clockOutAt: Date | null;
  absenceReason: string | null;
}

interface Row { staff_key: string; work_date: string; clock_in_at: Date | null; clock_out_at: Date | null; absence_reason: string | null }
const COLS = `staff_key, to_char(work_date, 'YYYY-MM-DD') AS work_date, clock_in_at, clock_out_at, absence_reason`;
const toRec = (r: Row): AttendanceRecord => ({ staffKey: r.staff_key, workDate: r.work_date, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, absenceReason: r.absence_reason });

/** Clock in for today (the shop's date). One clock-in per person per day. */
export async function clockIn(pool: Pool, input: { staffKey: string; at?: Date }): Promise<AttendanceRecord> {
  if (!input.staffKey?.trim()) throw new HttpError(422, 'ATTENDANCE_NO_STAFF', 'Who is clocking in?');
  const at = input.at ?? new Date();
  await assertPeriodOpen(pool, shopDate(at));
  try {
    const { rows } = await pool.query<Row>(
      `INSERT INTO attendance_records (staff_key, work_date, clock_in_at, recorded_by) VALUES ($1, $2, $3, $1) RETURNING ${COLS}`,
      [input.staffKey.trim(), shopDate(at), at]);
    return toRec(rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'ALREADY_RECORDED', 'Attendance for that person today is already recorded.');
    throw err;
  }
}

/** Clock out. Sets the clock-out on the person's most recent open clock-in, once. */
export async function clockOut(pool: Pool, input: { staffKey: string; at?: Date }): Promise<AttendanceRecord> {
  const at = input.at ?? new Date();
  const open = await pool.query<{ id: number; work_date: string }>(
    `SELECT id, to_char(work_date, 'YYYY-MM-DD') AS work_date FROM attendance_records WHERE staff_key = $1 AND clock_in_at IS NOT NULL AND clock_out_at IS NULL ORDER BY work_date DESC LIMIT 1`, [input.staffKey]);
  if (!open.rows[0]) throw new HttpError(409, 'NOT_CLOCKED_IN', 'There is no open clock-in to clock out of.');
  // A clock-out changes that day's missing-hours figure, so it cannot be added to a day inside a locked payroll run.
  await assertPeriodOpen(pool, open.rows[0].work_date);
  try {
    const { rows } = await pool.query<Row>(`UPDATE attendance_records SET clock_out_at = $2 WHERE id = $1 RETURNING ${COLS}`, [open.rows[0].id, at]);
    return toRec(rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === '23514') throw new HttpError(422, 'CLOCK_OUT_BEFORE_IN', 'The clock-out must be after the clock-in.');
    throw err;
  }
}

/** A manager records that someone did not come in. Refused if the day is already recorded or falls in a locked payroll run. */
export async function markAbsent(pool: Pool, input: { staffKey: string; workDate: string; reason: string; actor: string }): Promise<AttendanceRecord> {
  if (!input.staffKey?.trim()) throw new HttpError(422, 'ATTENDANCE_NO_STAFF', 'Who was absent?');
  if (!isDateString(input.workDate)) throw new HttpError(422, 'PAY_BAD_DATE', 'The date must be YYYY-MM-DD.');
  if (!input.reason?.trim()) throw new HttpError(422, 'ABSENCE_REASON_REQUIRED', 'A reason is required.');
  if (!input.actor?.trim()) throw new HttpError(422, 'PAY_NO_ACTOR', 'The person recording this is required.');
  await assertPeriodOpen(pool, input.workDate);
  try {
    const { rows } = await pool.query<Row>(
      `INSERT INTO attendance_records (staff_key, work_date, absence_reason, recorded_by) VALUES ($1, $2, $3, $4) RETURNING ${COLS}`,
      [input.staffKey.trim(), input.workDate, input.reason.trim(), input.actor.trim()]);
    return toRec(rows[0]!);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'ALREADY_RECORDED', 'Attendance for that person on that date is already recorded.');
    throw err;
  }
}

export async function attendanceFor(db: Queryable, staffKey: string, from: string, to: string): Promise<AttendanceRecord[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${COLS} FROM attendance_records WHERE staff_key = $1 AND work_date BETWEEN $2 AND $3 ORDER BY work_date`, [staffKey, from, to]);
  return rows.map(toRec);
}

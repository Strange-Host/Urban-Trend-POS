const { z } = require('zod');

// Zod objects ignore keys they don't know, which is deliberate for the mobile API: a newer app may send a field an
// older server has never heard of, and that must not break sign-in.
const device = z.object({
  deviceId: z.string().trim().min(1).max(100).optional(),     // the app's own install id
  name: z.string().trim().min(1).max(80).optional(),          // e.g. "Tecno Spark 10"
  platform: z.string().trim().max(40).optional(),             // e.g. "android 13"
  appVersion: z.string().trim().max(40).optional(),
});

const mobileLogin = z.object({
  email: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(200),
  device: device.optional(),
});

const mobileVerifyOtp = z.object({
  challengeToken: z.string().min(1).max(200),
  code: z.string().trim().min(1).max(12),
  device: device.optional(),
});

const refreshBody = z.object({ refreshToken: z.string().min(1).max(500) });

// POST /devices: every field optional, so the same call serves "I just got a push token" and "my app was updated".
const registerDevice = device.extend({
  pushToken: z.string().trim().max(4096).nullable().optional(),   // null or '' switches push off for this phone
});

// Decisions. A reject always carries a reason (the person who asked is told it). `biometricConfirmed` is the phone saying the
// person just passed the fingerprint / face check; the server only asks for it above the owner's amount (settings
// approval_biometric_above_kes), and records it in the audit log. It is a second lock on a phone that is already signed in,
// not a replacement for the permission check, which always happens here.
const approveBody = z.object({ biometricConfirmed: z.boolean().optional() });
const rejectBody = z.object({ reason: z.string().trim().min(3, 'Say why (a few words is enough)').max(300) });

const STOCK_REASONS = ['damaged', 'lost', 'found', 'count_correction', 'return_to_stock', 'other'];
const stockAdjustment = z.object({
  productId: z.number().int().positive(),
  delta: z.number().int().refine((n) => n !== 0, 'delta cannot be 0'),
  reason: z.enum(STOCK_REASONS),
  note: z.string().trim().max(200).optional(),
});

const preferences = z.object({
  quietHours: z.object({
    enabled: z.boolean(),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 22:00').optional(),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 06:00').optional(),
  }),
});

module.exports = { mobileLogin, mobileVerifyOtp, refreshBody, registerDevice, approveBody, rejectBody, stockAdjustment, preferences, STOCK_REASONS };

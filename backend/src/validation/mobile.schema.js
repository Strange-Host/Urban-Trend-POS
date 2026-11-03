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

module.exports = { mobileLogin, mobileVerifyOtp, refreshBody, registerDevice };

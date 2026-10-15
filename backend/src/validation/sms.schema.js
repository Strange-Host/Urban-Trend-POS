const { z } = require('zod');

// Every field optional so re-saving the sender ID doesn't force you to retype
// the password — the service enforces "both user ID and password at first save".
const saveSmsCredentialsSchema = z.object({
  user_id: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(1).max(200).optional(),
  sender_id: z.string().trim().max(20).optional(),
});

const sendTestSmsSchema = z.object({
  to: z.string().trim().min(7).max(20),
});

module.exports = { saveSmsCredentialsSchema, sendTestSmsSchema };

// What each payment gateway needs filled in, and the limits on the M-Pesa test prompt.

export const GATEWAY_FIELDS = {
  mpesa: {
    label: 'M-Pesa (Safaricom Daraja)',
    plain: [
      { key: 'mpesa_shortcode', label: 'Paybill / Till number', hint: 'Published to customers — this is what they pay to, not a secret.' },
      { key: 'mpesa_initiator_name', label: 'Initiator name', hint: 'Only needed for B2C (money going OUT — supplier/refund payments), not for receiving payments.' },
    ],
    // Required to receive/match incoming payments — "Configured" reflects only these.
    coreSecret: ['mpesa_consumer_key', 'mpesa_consumer_secret', 'mpesa_passkey'],
    secret: [
      { key: 'mpesa_consumer_key', label: 'Consumer key' },
      { key: 'mpesa_consumer_secret', label: 'Consumer secret' },
      { key: 'mpesa_passkey', label: 'Passkey', hint: 'From the Daraja portal, used to validate STK push / C2B callbacks.' },
      { key: 'mpesa_initiator_password', label: 'Initiator password', hint: 'For B2C (money out) only — not required just to receive payments.' },
    ],
  },
  kcb: {
    label: 'KCB',
    plain: [
      { key: 'kcb_account_number', label: 'Account number' },
    ],
    coreSecret: ['kcb_client_id', 'kcb_api_key', 'kcb_api_secret'],
    secret: [
      { key: 'kcb_client_id', label: 'Client ID' },
      { key: 'kcb_api_key', label: 'API key' },
      { key: 'kcb_api_secret', label: 'API secret' },
    ],
  },
};
export const STK_TEST_MAX = 10; // KES. A test prompt is for checking the wiring, not for taking money.
export const STK_PHONE = /^2547\d{8}$/;

import client from '../client';
import { mapResponse } from './common';
import { adaptSessionPayload } from './auth-shape';

export { adaptUser, adaptSessionPayload } from './auth-shape';

// Sign-in, sessions and the lock screen. The new server already speaks the same routes, the same error codes
// ({ error: { code, message } }, SESSION_LOCKED, REAUTH_REQUIRED, SESSION_EXPIRED, PASSWORD_CHANGE_REQUIRED) and the same
// session policy object, so only the shape of the person differs.

export const newAuthApi = {
  login: (email, password, remember = false) => mapResponse(client.post('/auth/login', { email, password, remember }), adaptSessionPayload),
  // The new server has no SMS sign-in codes yet: an account that needs one is refused at login (TWO_FACTOR_UNAVAILABLE).
  verifyOtp: () => Promise.reject(Object.assign(new Error('Sign-in codes are not available on the new server yet.'), { response: { status: 501, data: { error: { code: 'NOT_IMPLEMENTED_ON_NEW_SERVER', message: 'Sign-in codes are not available on the new server yet.' } } } })),
  resendOtp: () => newAuthApi.verifyOtp(),
  unlock: (secret) => client.post('/auth/unlock', secret),
  activity: () => client.post('/auth/activity', {}),
  sessions: () => client.get('/auth/sessions'),
  endSession: (id) => client.delete(`/auth/sessions/${id}`),
  endOtherSessions: () => client.post('/auth/sessions/revoke-others', {}),
  refresh: () => mapResponse(client.post('/auth/refresh'), adaptSessionPayload),
  logout: () => client.post('/auth/logout'),
  me: () => mapResponse(client.get('/auth/me'), adaptSessionPayload),
  changePassword: (currentPassword, newPassword) => client.post('/auth/change-password', { currentPassword, newPassword }),
};

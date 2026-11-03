const { z } = require('zod');
const req = require('../validation/mobile.schema');
const res = require('../validation/mobile.responses');

// The OpenAPI 3.1 description of /api/v1, generated from the same zod schemas the routes validate with (requests) and the
// contract tests check against (responses). The typed client for the app is generated from this document, so a change to a
// schema reaches the app's types with no hand-copying.
//
// To add an endpoint: add it to the router (routes/v1/index.js) AND to ENDPOINTS below. tests/mobileOpenApi.test.js fails
// if the two lists ever disagree, so an endpoint cannot ship undocumented.

const err = (description) => ({ description, schema: res.ErrorResponse });
const UNAUTH = err('Missing, invalid, expired or revoked access token (code SESSION_EXPIRED when the sign-in has ended)');
const BAD = err('The request body or query is invalid');
const FORBIDDEN = err('The signed-in person may not do this (code FORBIDDEN)');
const NOT_FOUND = err('Not found, or not yours');
const LIMITED = err('Too many attempts, or the account is temporarily locked (code ACCOUNT_LOCKED / RATE_LIMITED)');

const ENDPOINTS = [
  {
    method: 'post', path: '/auth/mobile/login', tag: 'Sign-in', auth: false, operationId: 'mobileLogin',
    summary: 'Sign in with email and password',
    description: 'Same lockout, sign-in-code and replay rules as the website. The refresh token comes back in the body, not a cookie.',
    body: req.mobileLogin,
    responses: { 200: { description: 'Signed in, or a sign-in code was sent', schema: res.LoginResponse }, 400: BAD, 401: err('Wrong email or password'), 429: LIMITED },
  },
  {
    method: 'post', path: '/auth/mobile/verify-otp', tag: 'Sign-in', auth: false, operationId: 'mobileVerifyOtp',
    summary: 'Answer a sign-in code challenge',
    body: req.mobileVerifyOtp,
    responses: { 200: { description: 'Signed in', schema: res.MobileSession }, 400: BAD, 401: err('The code is wrong or has expired'), 429: LIMITED },
  },
  {
    method: 'post', path: '/auth/mobile/refresh', tag: 'Sign-in', auth: false, operationId: 'mobileRefresh',
    summary: 'Trade a refresh token for a new access token and a new refresh token',
    description: 'The old refresh token stops working. Presenting an already-used one after the short grace period signs the phone out and alerts the owner.',
    body: req.refreshBody,
    responses: { 200: { description: 'New tokens', schema: res.MobileSession }, 400: BAD, 401: err('Unknown, used, expired or revoked refresh token') },
  },
  {
    method: 'post', path: '/auth/mobile/logout', tag: 'Sign-in', auth: false, operationId: 'mobileLogout',
    summary: 'Sign this phone out',
    description: 'Always succeeds, even for an unknown token.',
    body: req.refreshBody,
    responses: { 204: { description: 'Signed out', schema: null }, 400: BAD },
  },
  {
    method: 'get', path: '/app/version', tag: 'App', auth: false, operationId: 'getAppVersion',
    summary: 'Minimum and latest app version',
    description: 'Public: an app too old to sign in must still be able to read it. Pass your own version as ?current= to get updateRequired / updateAvailable.',
    query: [{ name: 'current', description: 'The version of the app asking, e.g. 1.2.0', schema: { type: 'string' } }],
    responses: { 200: { description: 'The release gate', schema: res.AppVersion } },
  },
  {
    method: 'get', path: '/home/attention', tag: 'Home', auth: true, operationId: 'getHomeAttention',
    summary: 'What is waiting on you',
    description: 'Routed by permission: you only see what you could act on, and never your own requests. Cached on the server for about 45 seconds.',
    responses: { 200: { description: 'Most urgent first, oldest first within a level; up to 50 items', schema: res.Attention }, 401: UNAUTH },
  },
  {
    method: 'get', path: '/home/summary', tag: 'Home', auth: true, operationId: 'getHomeSummary',
    summary: 'Today at a glance',
    description: 'Cached on the server for about 45 seconds.',
    responses: { 200: { description: 'Shop figures or just your own, by permission', schema: res.Summary }, 401: UNAUTH },
  },
  {
    method: 'post', path: '/devices', tag: 'Devices', auth: true, operationId: 'registerDevice',
    summary: 'Register this phone and its push token',
    description: 'Call after sign-in, whenever Firebase issues a new push token, and after an app update. Send pushToken: null to switch pushes off for this phone.',
    body: req.registerDevice,
    responses: { 200: { description: 'The phone as the server now has it', schema: z.looseObject({ device: res.Device }) }, 400: BAD, 401: UNAUTH, 403: err('Not a mobile sign-in (code MOBILE_ONLY)') },
  },
  {
    method: 'get', path: '/devices', tag: 'Devices', auth: true, operationId: 'listDevices',
    summary: 'Your signed-in phones (admins: everyone\'s with ?all=1)',
    query: [{ name: 'all', description: '1 = every phone in the business. Admin only', schema: { type: 'string', enum: ['1', 'true'] } }],
    responses: { 200: { description: 'Live phones, most recently seen first', schema: z.looseObject({ devices: z.array(res.Device) }) }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'delete', path: '/devices/{id}', tag: 'Devices', auth: true, operationId: 'revokeDevice',
    summary: 'Sign a phone out',
    description: 'Your own phone, or any phone for an admin. A revoked phone is refused on its very next request and its refresh tokens stop working.',
    pathParams: [{ name: 'id', description: 'The device id from the list', schema: { type: 'integer' } }],
    responses: { 200: { description: 'Revoked (or already was)', schema: res.RevokeResult }, 401: UNAUTH, 404: NOT_FOUND },
  },
  {
    method: 'get', path: '/openapi.json', tag: 'App', auth: false, operationId: 'getOpenApi',
    summary: 'This document',
    responses: { 200: { description: 'OpenAPI 3.1', schema: null } },
  },
];

// zod -> JSON Schema 2020-12, which is what OpenAPI 3.1 uses. `io` picks the input side for requests (defaults filled in
// by the server are optional for the caller) and the output side for responses.
function jsonSchema(schema, io) {
  const out = z.toJSONSchema(schema, { io, unrepresentable: 'any' });
  delete out.$schema;
  return out;
}

function build() {
  const paths = {};
  for (const e of ENDPOINTS) {
    const parameters = [
      ...(e.pathParams || []).map((p) => ({ name: p.name, in: 'path', required: true, description: p.description, schema: p.schema })),
      ...(e.query || []).map((p) => ({ name: p.name, in: 'query', required: false, description: p.description, schema: p.schema })),
    ];
    const responses = {};
    for (const [status, r] of Object.entries(e.responses)) {
      responses[status] = r.schema
        ? { description: r.description, content: { 'application/json': { schema: jsonSchema(r.schema, 'output') } } }
        : { description: r.description };
    }
    paths[e.path] = {
      ...(paths[e.path] || {}),
      [e.method]: {
        operationId: e.operationId, tags: [e.tag], summary: e.summary, ...(e.description ? { description: e.description } : {}),
        ...(parameters.length ? { parameters } : {}),
        ...(e.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(e.body, 'input') } } } } : {}),
        security: e.auth ? [{ bearerAuth: [] }] : [],
        responses,
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Urban Trends POS - mobile API',
      version: '1.0.0',
      description: 'The API the Android app uses. Compatibility rule: fields and endpoints may be ADDED, but nothing is renamed or removed while an older app may still be installed; a breaking change goes to /api/v2. Clients must ignore fields they do not know.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [{ name: 'Sign-in' }, { name: 'Home' }, { name: 'Devices' }, { name: 'App' }],
    paths,
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
  };
}

module.exports = { ENDPOINTS, build };

const req = require('../validation/mobile.v2.schema');
const res = require('../validation/mobile.v2.responses');
const { helpers } = require('./v11');

// The v2 endpoints (telesales orders, leads, returns), appended to the list in openapi/v1.js.
// Same rule as there: add the route to routes/v1/index.js AND an entry here.
const { err, UNAUTH, BAD, FORBIDDEN, NOT_FOUND, idParam, pageQuery } = helpers;

const ENDPOINTS = [
  // ---- telesales
  {
    method: 'get', path: '/telesales/orders', tag: 'Telesales', auth: true, operationId: 'listTelesalesOrders', summary: 'My orders waiting for a confirmation call (oldest first)',
    description: 'Needs telesales.work. Only COD orders assigned to the caller that are not yet confirmed. confirmBy is the end of the confirmation window.',
    query: pageQuery, responses: { 200: { description: 'A page of orders, plus the total waiting', schema: res.TelesalesOrders }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/telesales/orders/{id}', tag: 'Telesales', auth: true, operationId: 'getTelesalesOrder', summary: 'One of my orders, with anything that needs a warning',
    description: 'An order assigned to someone else answers 404, exactly like one that does not exist. duplicates lists other active orders on the same phone number.',
    pathParams: [idParam], responses: { 200: { description: 'The order', schema: res.TelesalesOrder }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'post', path: '/orders/{id}/confirm', tag: 'Telesales', auth: true, operationId: 'confirmTelesalesOrder', summary: 'Confirm an order after the call',
    description: 'Goes through the website\'s COD gate. A duplicate-phone order is refused with DUPLICATE_PHONE until a manager approves it (an approver may confirm directly). An elapsed window cancels the order and answers 409.',
    pathParams: [idParam], responses: { 200: { description: 'The order, now confirmed', schema: res.TelesalesOrder }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('DUPLICATE_PHONE, NOT_AWAITING, or the window had elapsed') },
  },
  {
    method: 'post', path: '/orders/{id}/reschedule', tag: 'Telesales', auth: true, operationId: 'rescheduleTelesalesOrder', summary: 'Customer asked to be called later',
    description: 'callbackAt must be in the future and at most 7 days ahead. The confirmation window restarts from that time so the order does not cancel before the call.',
    pathParams: [idParam], body: req.rescheduleOrder,
    responses: { 200: { description: 'The order with its new callbackAt', schema: res.TelesalesOrder }, 400: err('INVALID_TIME or an invalid body'), 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NOT_AWAITING') },
  },
  {
    method: 'post', path: '/orders/{id}/cancel', tag: 'Telesales', auth: true, operationId: 'cancelTelesalesOrder', summary: 'Customer does not want it',
    description: 'A reason is required. Only an unconfirmed COD order can be cancelled this way.', pathParams: [idParam], body: req.cancelOrder,
    responses: { 200: { description: 'The order, now cancelled', schema: res.TelesalesOrder }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NOT_AWAITING') },
  },
  {
    method: 'post', path: '/orders/{id}/duplicate-approval', tag: 'Telesales', auth: true, operationId: 'requestDuplicateApproval', summary: 'Ask a manager to approve confirming a duplicate-phone order',
    description: 'Idempotent while a request is open (200 with the existing one). The manager decides it from GET /approvals (type duplicate_order).',
    pathParams: [idParam], body: req.requestDuplicateApproval,
    responses: { 200: { description: 'A request is already open', schema: res.DuplicateApprovalResult }, 201: { description: 'Requested', schema: res.DuplicateApprovalResult }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NO_DUPLICATE or NOT_AWAITING') },
  },

  // ---- leads
  {
    method: 'get', path: '/leads', tag: 'Leads', auth: true, operationId: 'listLeads', summary: 'Leads (an agent sees only their own)',
    description: 'Needs leads.work.',
    query: [{ name: 'status', description: 'One status', schema: { type: 'string', enum: ['new', 'contacted', 'rescheduled', 'converted', 'cancelled'] } }, { name: 'q', description: 'Name or phone contains', schema: { type: 'string' } }, ...pageQuery],
    responses: { 200: { description: 'A page of leads, newest first', schema: res.Leads }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/leads/{id}', tag: 'Leads', auth: true, operationId: 'getLead', summary: 'One lead with its notes and call history', pathParams: [idParam],
    responses: { 200: { description: 'The lead', schema: res.LeadDetail }, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'patch', path: '/leads/{id}', tag: 'Leads', auth: true, operationId: 'updateLead', summary: 'Change a lead\'s status or notes', pathParams: [idParam], body: req.patchLead,
    description: 'The website\'s status rules apply. followUpDate (YYYY-MM-DD) is required when moving to rescheduled. A lead cannot be set to converted here (USE_CONVERT): convert it to an order instead.',
    responses: { 200: { description: 'The lead', schema: res.LeadDetail }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('The status change is not allowed from the current status') },
  },
  {
    method: 'post', path: '/leads/{id}/activities', tag: 'Leads', auth: true, operationId: 'addLeadActivity', summary: 'Record a call, message or note', pathParams: [idParam], body: req.leadActivity,
    description: 'Call outcomes are recorded by the agent; nothing is detected automatically.',
    responses: { 201: { description: 'The lead with the new entry', schema: res.LeadDetail }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND },
  },
  {
    method: 'post', path: '/leads/{id}/convert', tag: 'Leads', auth: true, operationId: 'convertLead', summary: 'Turn a lead into an order', pathParams: [idParam], body: req.convertLead,
    description: 'One transaction. A phone number that already has an active order answers 409 with its id; send mergeIntoOrderId to add to it instead.',
    responses: { 200: { description: 'Merged into an existing order', schema: res.LeadConverted }, 201: { description: 'Order created', schema: res.LeadConverted }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('Already converted, cancelled, or the phone has an active order') },
  },

  // ---- returns
  {
    method: 'get', path: '/returns', tag: 'Returns', auth: true, operationId: 'listReturns', summary: 'Returned parcels',
    description: 'Needs returns.receive. A return is the order that came back, so its id is the order id.',
    query: [{ name: 'status', description: 'awaiting (default): waiting for a decision; decided: already decided', schema: { type: 'string', enum: ['awaiting', 'decided'] } }, ...pageQuery],
    responses: { 200: { description: 'A page of returns, newest first', schema: res.Returns }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'get', path: '/returns/orders', tag: 'Returns', auth: true, operationId: 'findReturnableOrders', summary: 'Find a dispatched order that came back',
    query: [{ name: 'q', description: 'Order number, customer name or phone (at least 2 characters)', schema: { type: 'string' } }],
    responses: { 200: { description: 'Up to 20 orders', schema: res.ReceivableOrders }, 401: UNAUTH, 403: FORBIDDEN },
  },
  {
    method: 'post', path: '/returns', tag: 'Returns', auth: true, operationId: 'receiveReturn', summary: 'Receive a returned parcel', body: req.receiveReturn,
    description: 'Records the reason code and the condition staff found. Stock does not move until the owner decides.',
    responses: { 201: { description: 'The return, now awaiting a decision', schema: res.ReturnItem }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NOT_RETURNABLE') },
  },
  {
    method: 'post', path: '/returns/{id}/decision', tag: 'Returns', auth: true, operationId: 'decideReturn', summary: 'Decide what happens to a returned parcel', pathParams: [idParam], body: req.returnDecision,
    description: 'restock needs orders.inspect and puts the units back on sale. write_off and dispose are the owner\'s (admin) and keep stock out. Same rules as the website.',
    responses: { 200: { description: 'The decided return', schema: res.ReturnItem }, 400: BAD, 401: UNAUTH, 403: FORBIDDEN, 404: NOT_FOUND, 409: err('NOT_RECEIVED, ALREADY_DECIDED or NOT_RESTOCKABLE') },
  },
];

module.exports = { ENDPOINTS };

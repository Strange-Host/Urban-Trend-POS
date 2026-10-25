// Which server the screens talk to. Off (the default) keeps every page on the legacy backend, unchanged.
// Turn it on with VITE_USE_NEW_SERVER=true to point the same screens at the new PostgreSQL/TypeScript server through the
// adapters in ./adapters, which hand each page the shapes it already expects.
export const USE_NEW_SERVER = import.meta.env.VITE_USE_NEW_SERVER === 'true';

// Zero-config like the legacy default: the new server is on the machine that served this page, port 3000.
export const NEW_API_BASE_URL = import.meta.env.VITE_NEW_API_URL
  || `${window.location.protocol}//${window.location.hostname || 'localhost'}:3000/api`;

// Shared JSDoc types for the typed folders (R5). Check-only: this file is never imported at runtime or built.
// Reference from JS with /** @type {import('../types').Id} */, or via the typedefs at the top of each file.

/** A database id as it travels in a URL: numbers from the API, strings from route params. */
export type Id = number | string;

/** A request body. Fields are checked by the backend (zod); the shapes are not duplicated here yet. */
export type Payload = Record<string, any>;

/** Query-string parameters. */
export type Params = Record<string, any>;

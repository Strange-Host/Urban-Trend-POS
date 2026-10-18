// The shape of every error the API returns, same contract as the legacy backend: { error: { code, message } }.
export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const gmailServiceCodes = [
  'invalid-request',
  'invalid-response',
  'needs-reauth',
  'network',
  'encryption-unavailable',
  'operation-in-progress',
  'rate-limited',
  'unavailable',
  'not-found',
  'too-large',
  'permission-denied',
  'insufficient-scope',
  'gmail-rejected',
  'internal'
] as const;

export type GmailServiceCode = (typeof gmailServiceCodes)[number];

const sentences: Record<GmailServiceCode, string> = {
  'invalid-request': 'Request rejected.',
  'invalid-response': 'Response rejected.',
  'needs-reauth': 'The saved Google credential can no longer be used.',
  network: 'Aurora could not reach Google.',
  'encryption-unavailable': 'Credential protection is unavailable.',
  'operation-in-progress': 'Another Google account change is already in progress.',
  'rate-limited': 'Gmail is limiting requests. Try again in a moment.',
  unavailable: 'Aurora could not read this mailbox.',
  'not-found': 'This conversation is no longer available.',
  'too-large': 'This conversation is too large to show.',
  'permission-denied': 'Gmail did not allow this request.',
  'insufficient-scope': 'Reconnect this Google account before changing mail.',
  'gmail-rejected': 'Gmail refused this request.',
  internal: 'Request failed.'
};

export class GmailError extends Error {
  readonly code: GmailServiceCode;
  readonly status: number | null;
  readonly reason: string | null;

  constructor(code: GmailServiceCode, status: number | null = null, reason: string | null = null) {
    super(sentences[code]);
    this.name = 'GmailError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

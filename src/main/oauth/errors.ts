export type OAuthFlowCode =
  | 'invalid-request'
  | 'needs-client'
  | 'client-in-use'
  | 'oauth-denied'
  | 'oauth-timeout'
  | 'oauth-cancelled'
  | 'callback-limit'
  | 'account-mismatch'
  | 'provider-rejected'
  | 'network'
  | 'encryption-unavailable'
  | 'needs-reauth'
  | 'operation-in-progress'
  | 'scope-denied'
  | 'internal';

const messages: Record<OAuthFlowCode, string> = {
  'invalid-request': 'Request rejected.',
  'needs-client': 'Add a Google OAuth Client ID in Settings.',
  'client-in-use': 'Disconnect the connected Google accounts before changing the Client ID.',
  'oauth-denied': 'Google sign-in was cancelled.',
  'oauth-timeout': 'Google sign-in timed out.',
  'oauth-cancelled': 'Google sign-in was cancelled.',
  'callback-limit': 'Google sign-in was interrupted.',
  'account-mismatch': 'The selected Google account does not match this connection.',
  'provider-rejected': 'Google rejected the sign-in.',
  network: 'Aurora could not reach Google.',
  'encryption-unavailable': 'Credential protection is unavailable.',
  'needs-reauth': 'The saved Google credential can no longer be used.',
  'operation-in-progress': 'Another Google account change is already in progress.',
  'scope-denied': 'Google did not grant permission to change mail. The saved account was kept.',
  internal: 'Request failed.'
};

export class OAuthFlowError extends Error {
  readonly code: OAuthFlowCode;

  constructor(code: OAuthFlowCode) {
    super(messages[code]);
    this.name = 'OAuthFlowError';
    this.code = code;
  }
}

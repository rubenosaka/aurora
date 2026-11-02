export const googleIssuers = ['https://accounts.google.com', 'accounts.google.com'] as const;

export type GoogleIssuer = (typeof googleIssuers)[number];

export function isGoogleIssuer(value: string): value is GoogleIssuer {
  return googleIssuers.some((issuer) => issuer === value);
}

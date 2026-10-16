export interface SenderSnapshot {
  senderId: number | null;
  authorizedSenderId: number | null;
  frameUrl: string | null;
  isMainFrame: boolean;
  authorizedUrl: string;
}

function canonicalDocumentUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '' || url.search !== '') return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:')
    return null;
  url.hash = '';
  return url.href;
}

export function isAuthorizedSender(sender: SenderSnapshot): boolean {
  if (sender.senderId === null || sender.authorizedSenderId === null) return false;
  if (sender.senderId !== sender.authorizedSenderId) return false;
  if (!sender.isMainFrame || sender.frameUrl === null) return false;
  const actual = canonicalDocumentUrl(sender.frameUrl);
  const authorized = canonicalDocumentUrl(sender.authorizedUrl);
  return actual !== null && actual === authorized;
}

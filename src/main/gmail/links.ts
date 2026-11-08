function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function parsedUrl(value: string): URL | null {
  if (value.length < 1 || value.length > 2048) return null;
  if (hasControlCharacter(value) || /\s/.test(value) || value.includes('\\')) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function accepted(url: URL): boolean {
  if (url.username !== '' || url.password !== '') return false;
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname.length > 0;
  if (url.protocol !== 'mailto:') return false;
  const address = url.pathname.replace(/^\/+/, '');
  return address.length > 0;
}

export function acceptExternalUrl(value: string): string | null {
  const url = parsedUrl(value);
  if (url === null || !accepted(url)) return null;
  const href = url.href;
  if (href === value) return href;
  const again = parsedUrl(href);
  if (again === null || !accepted(again) || again.href !== href) return null;
  return href;
}

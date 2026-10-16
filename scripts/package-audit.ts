export const auroraIconPath = 'build/icon.ico';

export const requiredAsarEntries = [
  'package.json',
  'out/main/index.js',
  'out/preload/index.js',
  'out/renderer/index.html',
  'out/renderer/theme-init.js'
] as const;

export function missingIconMessage(): string {
  return 'Blocking prerequisite: build/icon.ico is missing. Packaging requires an original Aurora icon. The Electron default icon is not used.';
}

export function normalizePackageEntry(entry: string): string {
  return entry.replaceAll('\\', '/').replace(/^\/+/, '');
}

export function packageEntryProblem(entry: string): string | null {
  const normalized = normalizePackageEntry(entry);
  if (normalized === '') return null;
  const parts = normalized.split('/');
  const base = parts[parts.length - 1] ?? normalized;
  if (parts.some((part) => part === 'node_modules' || part === '.git' || part === '.github')) {
    return `${normalized} is a dependency or repository path`;
  }
  if (
    parts[0] === 'src' ||
    parts[0] === 'docs' ||
    parts[0] === 'scripts' ||
    parts[0] === 'coverage'
  ) {
    return `${normalized} is a development source path`;
  }
  if (/\.(test|spec)\.(ts|js|mjs|cjs)$/.test(base)) return `${normalized} is a test file`;
  if (base === '.env' || base.startsWith('.env.')) return `${normalized} is an environment file`;
  if (/\.(pem|pfx|p12|snk)$/i.test(base)) return `${normalized} is a certificate`;
  if (
    /^[a-zA-Z]:/.test(normalized) ||
    parts.includes('Users') ||
    parts.includes('ruben') ||
    parts.includes('rubenosaka')
  ) {
    return `${normalized} is a machine-specific or personal path`;
  }
  return null;
}

export interface PackagedPackageJson {
  name?: string;
  version?: string;
  productName?: string;
}

export function packagedIdentityProblem(pkg: PackagedPackageJson): string | null {
  if (pkg.name !== 'aurora') return `packaged name is ${String(pkg.name)}`;
  if (pkg.version !== '0.0.0') return `packaged version is ${String(pkg.version)}`;
  if (pkg.productName !== undefined && pkg.productName !== 'aurora') {
    return `packaged productName is ${pkg.productName}`;
  }
  return null;
}

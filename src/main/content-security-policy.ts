import type { Plugin } from 'vite';

const devContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ');

const prodContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
  "form-action 'none'"
].join('; ');

export function contentSecurityPolicy(devServer: boolean): string {
  return devServer ? devContentSecurityPolicy : prodContentSecurityPolicy;
}

export function injectContentSecurityPolicy(html: string, devServer: boolean): string {
  const policy = contentSecurityPolicy(devServer);
  return html.replace(
    '<head>',
    `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`
  );
}

export function applyContentSecurityPolicy(html: string, ctx: { server?: unknown }): string {
  return injectContentSecurityPolicy(html, Boolean(ctx.server));
}

export function contentSecurityPolicyPlugin(): Plugin {
  return {
    name: 'aurora-content-security-policy',
    transformIndexHtml: {
      order: 'post',
      handler: applyContentSecurityPolicy
    }
  };
}

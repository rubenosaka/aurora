import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  applyContentSecurityPolicy,
  contentSecurityPolicy,
  contentSecurityPolicyPlugin,
  injectContentSecurityPolicy
} from './content-security-policy.ts';

const html =
  '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n  </head>\n</html>\n';

function directives(policy: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    const space = trimmed.indexOf(' ');
    if (space === -1) parsed.set(trimmed, '');
    else parsed.set(trimmed.slice(0, space), trimmed.slice(space + 1));
  }
  return parsed;
}

function policyFrom(transformed: string): string {
  const match = transformed.match(/content="([^"]+)"/);
  assert.ok(match);
  return match[1];
}

function renderedPolicy(devServer: boolean): string {
  const plugin = contentSecurityPolicyPlugin();
  const transform = plugin.transformIndexHtml;
  assert.ok(transform && typeof transform === 'object' && 'handler' in transform);
  assert.equal(transform.handler, applyContentSecurityPolicy);
  return applyContentSecurityPolicy(html, { server: devServer ? {} : undefined });
}

describe('content security policy', () => {
  it('keeps unsafe-inline out of the production policy', () => {
    const policy = contentSecurityPolicy(false);
    const parsed = directives(policy);
    assert.equal(policy.includes('unsafe-inline'), false);
    assert.equal(policy.includes('ws:'), false);
    assert.equal(parsed.get('script-src'), "'self'");
    assert.equal(parsed.get('style-src'), "'self'");
    assert.equal(parsed.get('connect-src'), "'self'");
    assert.equal(parsed.get('object-src'), "'none'");
  });

  it('allows Vite style and localhost connections only in development', () => {
    const policy = contentSecurityPolicy(true);
    const parsed = directives(policy);
    assert.equal(parsed.get('script-src'), "'self'");
    assert.equal(parsed.get('style-src'), "'self' 'unsafe-inline'");
    assert.equal(parsed.get('connect-src')?.includes('ws://localhost:*'), true);
    assert.equal(parsed.get('connect-src')?.includes('http://localhost:*'), true);
  });

  it('injects the production policy as the first head element through the Vite plugin', () => {
    const output = renderedPolicy(false);
    assert.equal(output, injectContentSecurityPolicy(html, false));
    const head = output.slice(output.indexOf('<head>'), output.indexOf('</head>'));
    const firstTag = head.slice('<head>'.length).match(/<[^>]+>/)?.[0] ?? '';
    assert.equal(firstTag.includes('Content-Security-Policy'), true);
    assert.equal(policyFrom(output).includes('unsafe-inline'), false);
  });

  it('injects the development policy when the Vite server is present', () => {
    const output = renderedPolicy(true);
    assert.equal(output, injectContentSecurityPolicy(html, true));
    assert.equal(policyFrom(output).includes("style-src 'self' 'unsafe-inline'"), true);
  });

  it('is the policy plugin used by the Electron Vite config', () => {
    const source = readFileSync(new URL('../../electron.vite.config.ts', import.meta.url), 'utf8');
    assert.equal(source.includes('contentSecurityPolicyPlugin()'), true);
    assert.equal(source.includes('unsafe-inline'), false);
  });
});

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const rendererDir = join(root, 'out', 'renderer');
const htmlPath = join(rendererDir, 'index.html');

function fail(message: string): never {
  throw new Error(message);
}

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

function attribute(tag: string, name: string): string | undefined {
  const match = tag.match(new RegExp(`${name}="([^"]*)"`));
  return match?.[1];
}

if (!existsSync(htmlPath)) fail('Missing out/renderer/index.html. Run pnpm build first.');

for (const relative of ['out/main/index.js', 'out/preload/index.js']) {
  const file = join(root, relative);
  if (!existsSync(file) || statSync(file).size === 0) fail(`Missing build output ${relative}`);
}

const html = readFileSync(htmlPath, 'utf8');
const headStart = html.indexOf('<head>');
const headEnd = html.indexOf('</head>');
if (headStart === -1 || headEnd === -1) fail('Renderer HTML has no head');
const head = html.slice(headStart, headEnd);
const tags = [...head.matchAll(/<[^>]+>/g)].map((match) => match[0]);
const first = tags[1];
if (!first || !first.includes('http-equiv="Content-Security-Policy"')) {
  fail('Production CSP meta is not the first element in head');
}
const policy = attribute(first, 'content');
if (!policy) fail('Production CSP meta has no content');
if (policy.includes('unsafe-inline')) fail('Production CSP contains unsafe-inline');
const parsed = directives(policy);
assert.equal(parsed.get('script-src'), "'self'");
assert.equal(parsed.get('style-src'), "'self'");
assert.equal(parsed.get('connect-src'), "'self'");
assert.equal(parsed.get('object-src'), "'none'");

const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
if (scriptTags.length === 0) fail('Renderer HTML has no scripts');
for (const tag of scriptTags) {
  const src = attribute(tag, 'src');
  if (!src) fail('Renderer HTML contains an inline script');
  const file = join(rendererDir, src.replace(/^\.\//, ''));
  if (!existsSync(file) || statSync(file).size === 0) fail(`Missing script asset ${src}`);
}
if (!scriptTags.some((tag) => attribute(tag, 'src') === './theme-init.js')) {
  fail('Renderer HTML does not load theme-init.js');
}

const styles = [...html.matchAll(/<link\b[^>]*>/g)].map((match) => match[0]);
const stylesheet = styles.find((tag) => attribute(tag, 'rel') === 'stylesheet');
if (!stylesheet) fail('Renderer HTML has no stylesheet');
const href = attribute(stylesheet, 'href');
if (!href) fail('Stylesheet has no href');
const styleFile = join(rendererDir, href.replace(/^\.\//, ''));
if (!existsSync(styleFile) || statSync(styleFile).size === 0) fail(`Missing stylesheet ${href}`);
if (html.includes('<style')) fail('Renderer HTML contains an inline style block');

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

const leakedTests = filesUnder(join(root, 'out')).filter((file) =>
  /\.(test|spec)\.(ts|js|mjs|cjs)$/.test(file)
);
if (leakedTests.length > 0) fail(`Build output contains test files: ${leakedTests.join(', ')}`);

console.log('build output verified');

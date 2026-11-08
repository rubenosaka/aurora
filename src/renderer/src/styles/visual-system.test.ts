import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8').replaceAll(
  '\r\n',
  '\n'
);
const mail = readFileSync(new URL('../features/mail/mail.css', import.meta.url), 'utf8').replaceAll(
  '\r\n',
  '\n'
);

describe('visual system', () => {
  it('gives clickable controls a pointer, a hover, a focus ring, and a quiet disabled state', () => {
    assert.equal(tokens.includes('.control {\n  display: inline-flex;'), true);
    assert.equal(tokens.includes('cursor: pointer;'), true);
    assert.equal(tokens.includes('.control:hover:not(:disabled)'), true);
    assert.equal(tokens.includes('.control:focus-visible'), true);
    assert.equal(tokens.includes('.control:disabled {\n  cursor: default;'), true);
    assert.equal(tokens.includes(".control[aria-busy='true']"), true);
    assert.equal(tokens.includes('cursor: progress;'), true);
    assert.equal(tokens.includes('.nav-link.router-link-exact-active'), true);
    assert.equal(mail.includes(".folder-button[aria-pressed='true']"), true);
    assert.equal(mail.includes('.mail-row:hover'), true);
    assert.equal(mail.includes('.mail-row:focus-visible'), true);
  });

  it('switches folders from a scrolling row to a column at the main width', () => {
    assert.equal(tokens.includes('container-name: shell;'), true);
    assert.equal(mail.includes('flex-wrap: nowrap;'), true);
    assert.equal(mail.includes('height: 40px;'), true);
    assert.equal(mail.includes('height: 56px;'), true);
    assert.equal(mail.includes('@container shell (min-width: 960px)'), true);
    assert.equal(mail.includes('grid-template-columns: 200px minmax(0, 1fr);'), true);
    assert.equal(mail.includes('.mail-screen.is-reading'), false);
    assert.equal(mail.includes('.mail-screen:not(.is-reading)'), true);
  });

  it('scopes reading styles without taking layout away from tables', () => {
    assert.equal(mail.includes('.mail-body :where(p)'), true);
    assert.equal(mail.includes('.mail-body :where(table p)'), true);
    assert.equal(mail.includes('max-width: 680px;'), true);
    assert.equal(mail.includes('table-layout'), false);
    assert.equal(mail.includes('border-collapse'), false);
    assert.equal(/\.mail-body[^{]*table[^{]*\{[^}]*display\s*:/.test(mail), false);
  });
});

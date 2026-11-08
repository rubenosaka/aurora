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

  it('keeps mail folders in a sidebar and scrolls only the message list', () => {
    assert.equal(tokens.includes('container-name: shell;'), true);
    assert.equal(mail.includes('grid-template-columns: 188px minmax(0, 1fr);'), true);
    const folders = mail.slice(mail.indexOf('.mail-folders {'), mail.indexOf('.folder-button {'));
    assert.equal(folders.includes('overflow-x'), false);
    assert.equal(folders.includes('overflow-y'), false);
    assert.equal(folders.includes('auto'), false);
    assert.equal(mail.includes('.mail-list'), true);
    assert.equal(mail.includes('overflow-y: auto;'), true);
    assert.equal(mail.includes('min-height: 64px;'), true);
    assert.equal(mail.includes('grid-template-columns: minmax(0, 1fr) 112px;'), true);
    assert.equal(mail.includes('.mail-folder-bar .mail-folder-toggle {\n  display: none;'), true);
    const collapsed = mail.slice(mail.indexOf('@container mail-screen (max-width: 560px)'));
    assert.equal(
      collapsed.includes('.mail-folder-bar .mail-folder-toggle {\n    display: inline-flex;'),
      true
    );
    assert.equal(mail.includes('@container mail-screen (max-width: 560px)'), true);
    assert.equal(mail.includes('grid-template-columns: 48px minmax(0, 1fr);'), true);
    assert.equal(mail.includes('.mail-line-primary'), true);
    assert.equal(mail.includes('.mail-line-secondary'), true);
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

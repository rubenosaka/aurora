import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

describe('SidebarNav keyboard', () => {
  it('does not add custom arrow-key handling', () => {
    const source = readFileSync(new URL('./SidebarNav.vue', import.meta.url), 'utf8');
    assert.equal(source.includes('@keydown'), false);
    assert.equal(source.includes('ArrowUp'), false);
    assert.equal(source.includes('ArrowDown'), false);
  });
});

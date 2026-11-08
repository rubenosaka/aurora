import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { saveDestination, writeDownload } from './download-file.ts';

describe('download files', () => {
  it('keeps the chosen path and does not append the attachment name', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aurora-save-'));
    try {
      const chosen = join(directory, 'notes.txt');
      const destination = saveDestination(chosen);
      assert.equal(destination, resolve(chosen));
      assert.equal(saveDestination(`${chosen}\0evil`), null);
      assert.equal(saveDestination('../secret.txt')?.endsWith(`${join('secret.txt')}`), true);
      assert.equal(destination?.endsWith('notes.txt'), true);
      assert.equal(destination?.includes('..'), false);
      assert.equal(saveDestination(''), null);
      assert.equal(saveDestination('a'.repeat(4097)), null);
      assert.equal(saveDestination('ok\u007f'), null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes the temporary file after a completed write', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aurora-write-'));
    try {
      const target = join(directory, 'saved.txt');
      await writeDownload(target, Buffer.from('hello'));
      assert.equal(readFileSync(target, 'utf8'), 'hello');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('removes the temporary file when the destination cannot be written', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aurora-write-'));
    try {
      const target = join(directory, 'missing', 'saved.txt');
      await assert.rejects(writeDownload(target, Buffer.from('hello')));
      assert.equal(existsSync(target), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

import { copyFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export function saveDestination(chosen: string): string | null {
  if (chosen.length === 0 || chosen.length > 4096) return null;
  for (const character of chosen) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) return null;
  }
  return resolve(chosen);
}

export async function writeDownload(target: string, bytes: Uint8Array): Promise<void> {
  const destination = saveDestination(target);
  if (destination === null) throw new Error('bad path');
  const directory = await mkdtemp(join(tmpdir(), 'aurora-download-'));
  const temp = join(directory, 'part');
  try {
    await writeFile(temp, bytes);
    try {
      await rename(temp, destination);
    } catch {
      await copyFile(temp, destination);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

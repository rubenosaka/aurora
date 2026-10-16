import { extractFile, listPackage } from '@electron/asar';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  auroraIconPath,
  missingIconMessage,
  normalizePackageEntry,
  packageEntryProblem,
  packagedIdentityProblem,
  requiredAsarEntries,
  type PackagedPackageJson
} from './package-audit.ts';

const root = join(import.meta.dirname, '..');

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function filesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

function directoryBytes(directory: string): number {
  return filesUnder(directory).reduce((total, file) => total + statSync(file).size, 0);
}

const icon = join(root, auroraIconPath);
if (!existsSync(icon) || statSync(icon).size === 0) fail(missingIconMessage());
if (process.argv.includes('--require-icon')) process.exit(0);

const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
};
const installerName = `Aurora-Setup-${metadata.version}.exe`;
const installer = join(root, 'release', installerName);
const unpacked = join(root, 'release', 'win-unpacked');
const executable = join(unpacked, 'Aurora.exe');
const asar = join(unpacked, 'resources', 'app.asar');

if (!existsSync(installer) || statSync(installer).size === 0) {
  fail(`Missing installer release/${installerName}. Run pnpm package first.`);
}
if (!existsSync(executable) || statSync(executable).size === 0) {
  fail('Missing unpacked executable release/win-unpacked/Aurora.exe.');
}
if (!existsSync(asar) || statSync(asar).size === 0) {
  fail('Missing unpacked archive release/win-unpacked/resources/app.asar.');
}

const asarEntries = listPackage(asar, { isPack: false }).map(normalizePackageEntry);
for (const entry of asarEntries) {
  const problem = packageEntryProblem(entry);
  if (problem) fail(`Packaged archive contains ${problem}`);
}
for (const required of requiredAsarEntries) {
  assert.equal(asarEntries.includes(required), true, `Packaged archive is missing ${required}`);
}

const packaged = JSON.parse(
  extractFile(asar, 'package.json').toString('utf8')
) as PackagedPackageJson;
const identity = packagedIdentityProblem(packaged);
if (identity) fail(identity);

for (const file of filesUnder(unpacked)) {
  const relative = file.slice(unpacked.length + 1);
  const problem = packageEntryProblem(relative);
  if (problem) fail(`Unpacked application contains ${problem}`);
}

const installerBytes = statSync(installer).size;
const unpackedBytes = directoryBytes(unpacked);
console.log(`installer: release/${installerName}`);
console.log(`installer-bytes: ${installerBytes}`);
console.log(`unpacked-bytes: ${unpackedBytes}`);
console.log('unpacked-executable: release/win-unpacked/Aurora.exe');
console.log('asar: release/win-unpacked/resources/app.asar');
for (const entry of requiredAsarEntries) console.log(`asar-entry: ${entry}`);
console.log('packaging verification passed');

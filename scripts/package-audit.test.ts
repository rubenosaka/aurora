import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  missingIconMessage,
  packageEntryProblem,
  packagedIdentityProblem,
  requiredAsarEntries
} from './package-audit.ts';

describe('package audit', () => {
  it('requires the runtime resources', () => {
    assert.deepEqual(requiredAsarEntries, [
      'package.json',
      'out/main/index.js',
      'out/preload/index.js',
      'out/renderer/index.html',
      'out/renderer/theme-init.js'
    ]);
  });

  it('states that packaging stops without an original icon', () => {
    assert.equal(missingIconMessage().includes('build/icon.ico'), true);
    assert.equal(missingIconMessage().includes('Electron default icon is not used'), true);
  });

  it('rejects tests, secrets, source, and personal paths', () => {
    assert.equal(
      packageEntryProblem('out/renderer/theme-init.test.ts')?.includes('test file'),
      true
    );
    assert.equal(packageEntryProblem('out/renderer/theme-init.js'), null);
    assert.equal(packageEntryProblem('.env')?.includes('environment file'), true);
    assert.equal(packageEntryProblem('.env.local')?.includes('environment file'), true);
    assert.equal(packageEntryProblem('certs/app.pfx')?.includes('certificate'), true);
    assert.equal(packageEntryProblem('src/main/index.ts')?.includes('development source'), true);
    assert.equal(
      packageEntryProblem('node_modules/electron/package.json')?.includes('dependency'),
      true
    );
    assert.equal(packageEntryProblem('Users/ruben/aurora')?.includes('personal'), true);
    assert.equal(
      packageEntryProblem('C:/rga/aurora/out/main/index.js')?.includes('machine-specific'),
      true
    );
  });

  it('keeps the packaged application name and version', () => {
    assert.equal(packagedIdentityProblem({ name: 'aurora', version: '0.0.0' }), null);
    assert.equal(
      packagedIdentityProblem({ name: 'aurora', version: '0.0.0', productName: 'aurora' }),
      null
    );
    assert.equal(
      packagedIdentityProblem({
        name: 'aurora',
        version: '0.0.0',
        productName: 'Aurora'
      })?.includes('productName'),
      true
    );
    assert.equal(
      packagedIdentityProblem({ name: 'Aurora', version: '0.0.0' })?.includes('packaged name'),
      true
    );
  });
});

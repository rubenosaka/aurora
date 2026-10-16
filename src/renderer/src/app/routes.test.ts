import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shellRouteByPath, shellRoutes, unknownRouteRedirect } from './routes.ts';

describe('shell routes', () => {
  it('lists Dashboard, Integrations, and Settings', () => {
    assert.deepEqual(
      shellRoutes.map((route) => [route.name, route.path, route.title]),
      [
        ['dashboard', '/', 'Dashboard'],
        ['integrations', '/integrations', 'Integrations'],
        ['settings', '/settings', 'Settings']
      ]
    );
  });

  it('resolves a known path and leaves unknown paths to the redirect', () => {
    assert.equal(shellRouteByPath('/settings')?.name, 'settings');
    assert.equal(shellRouteByPath('/missing'), undefined);
    assert.equal(unknownRouteRedirect, '/');
  });
});

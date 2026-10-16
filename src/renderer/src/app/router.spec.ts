import { describe, expect, it } from 'vitest';
import { createAppRouter } from './router.ts';

describe('createAppRouter', () => {
  it('redirects an unknown hash route to the dashboard', async () => {
    const router = createAppRouter();
    await router.push('/missing');
    expect(router.currentRoute.value.path).toBe('/');
  });
});

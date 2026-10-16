export const shellRoutes = [
  { name: 'dashboard', path: '/', title: 'Dashboard' },
  { name: 'integrations', path: '/integrations', title: 'Integrations' },
  { name: 'settings', path: '/settings', title: 'Settings' }
] as const;

export const unknownRouteRedirect = '/';

export type ShellRouteName = (typeof shellRoutes)[number]['name'];

export function shellRouteByPath(path: string): (typeof shellRoutes)[number] | undefined {
  return shellRoutes.find((route) => route.path === path);
}

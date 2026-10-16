import { createRouter, createWebHashHistory } from 'vue-router';
import DashboardView from '../features/dashboard/DashboardView.vue';
import IntegrationsView from '../features/integrations/IntegrationsView.vue';
import SettingsView from '../features/settings/SettingsView.vue';
import { shellRoutes, unknownRouteRedirect, type ShellRouteName } from './routes.ts';

const views: Record<ShellRouteName, object> = {
  dashboard: DashboardView,
  integrations: IntegrationsView,
  settings: SettingsView
};

export function createAppRouter() {
  return createRouter({
    history: createWebHashHistory(),
    routes: [
      ...shellRoutes.map((route) => ({
        path: route.path,
        name: route.name,
        component: views[route.name]
      })),
      { path: '/:pathMatch(.*)*', redirect: unknownRouteRedirect }
    ]
  });
}

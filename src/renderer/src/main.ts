import { createApp } from 'vue';
import App from './App.vue';
import { createAppRouter } from './app/router.ts';
import { startTheme } from './features/settings/theme-runtime.ts';
import './styles/tokens.css';

startTheme();
createApp(App).use(createAppRouter()).mount('#app');

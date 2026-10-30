import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import './styles/theme.css';
import './styles/layout.css';
import './styles/components.css';
import './styles/screens.css';
import './styles/screens2.css';
import './styles/app.css';

createApp(App).use(createPinia()).mount('#app');

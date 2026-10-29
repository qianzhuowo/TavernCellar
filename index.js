import { init } from './src/link/main.js';

jQuery(() => {
    try {
        init();
    } catch (error) {
        console.error('[Cellar Link] failed to initialize', error);
    }
});

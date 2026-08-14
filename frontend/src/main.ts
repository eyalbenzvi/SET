/**
 * Entry point. Wires the store to the shell and starts the app.
 */

import './styles/base.css';
import './styles/components.css';
import './styles/game.css';
import { initLocale } from './i18n/index.js';
import { App } from './ui/app.js';
import { Store } from './state/store.js';

const root = document.getElementById('app');
if (!root) throw new Error('missing #app root element');

// Locale first: every string the shell builds is captured at build time.
initLocale();

const store = new Store();
const app = new App(store, root);
app.start();
store.init();

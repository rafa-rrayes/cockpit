// Webview entry: bundled to dist/webview.js and dist/webview.css.
import { render } from 'preact';
import { App } from './app';
import './styles.css';

const root = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'));
render(<App />, root);

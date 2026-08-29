import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../public/app.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('navigation hides Me-only navigation and panels outside Me', () => {
  assert.match(css, /\.app-nav\[hidden\], \.subnav\[hidden\], \.view\[hidden\] \{ display: none !important; \}/);
  assert.match(app, /document\.querySelector\('\[data-me-nav\]'\)\.hidden = view !== 'me'/);
  assert.match(app, /item\.hidden = item\.dataset\.viewPanel !== panel/);
  assert.match(html, /data-view-panel="me-account" hidden/);
  assert.match(html, /data-view-panel="me-notifications" hidden/);
});

test('an authenticated player sees only a deployment-configured feedback destination', async () => {
  const config = await readFile(new URL('../src/config.mjs', import.meta.url), 'utf8');
  assert.match(html, /id="feedback-link"[^>]*hidden/);
  assert.doesNotMatch(html, /feedback\.gameplan\.cookwithai\.app/);
  assert.match(app, /feedbackLink\.hidden = !me\.feedbackUrl/);
  assert.match(config, /FEEDBACK_URL/);
  assert.match(html, /Share feedback or request a feature/);
  assert.match(css, /\.feedback-link \{ color: #a9b4ff; font-weight: 700; \}/);
});

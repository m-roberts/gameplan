import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('..', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('public documentation uses a navigable Material for MkDocs site', async () => {
  const [config, index] = await Promise.all([
    read('mkdocs.yml'),
    read('docs/index.md'),
  ]);

  assert.match(config, /name: material/);
  assert.match(config, /- search/);
  assert.match(config, /navigation\.sections/);
  assert.match(config, /search\.suggest/);
  assert.match(config, /Quick start: quickstart\.md/);
  assert.match(config, /Architecture decisions:/);
  assert.match(index, /\[Quick start\]\(quickstart\.md\)/);
});

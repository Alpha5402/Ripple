import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTextareaEdit, textareaSource } from '../packages/host/source-edit.js';
test('source textarea preserves BOM, untouched mixed newlines and emoji while applying a local edit', () => {
  const raw = '\uFEFF# 标题\r\n\r\n😀 Promise\r\n原样一行\n最后一行\r';
  assert.equal(applyTextareaEdit(raw, textareaSource(raw)), raw);
  assert.equal(applyTextareaEdit(raw, textareaSource(raw).replace('Promise', '[[Promise]]')), raw.replace('Promise', '[[Promise]]'));
  assert.equal(applyTextareaEdit(raw, textareaSource(raw).replace('😀', '🐋')), raw.replace('😀', '🐋'));
  assert.equal(applyTextareaEdit(raw, textareaSource(raw).replace('原样一行\n', '')), raw.replace('原样一行\n', ''));
  assert.equal(applyTextareaEdit(raw, textareaSource(raw) + '新增\n一行'), raw + '新增\r\n一行');
});

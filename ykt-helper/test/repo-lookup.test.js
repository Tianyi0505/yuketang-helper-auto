import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupById } from '../src/state/repo-lookup.js';

test('lookupById 命中原始类型的键', () => {
  assert.equal(lookupById(new Map([['a', 1]]), 'a'), 1);
  assert.equal(lookupById(new Map([[7, 'x']]), 7), 'x');
});

test('lookupById 跨越数字与字符串键的差异', () => {
  assert.equal(lookupById(new Map([['123', 'str']]), 123), 'str', '数字 ID 应命中字符串键');
  assert.equal(lookupById(new Map([[123, 'num']]), '123'), 'num', '字符串 ID 应命中数字键');
});

test('lookupById 对空值与未命中返回 undefined', () => {
  const map = new Map([['a', 1]]);
  assert.equal(lookupById(map, undefined), undefined);
  assert.equal(lookupById(map, null), undefined);
  assert.equal(lookupById(map, 'missing'), undefined);
  assert.equal(lookupById(null, 'a'), undefined);
});

test('lookupById 不会把空字符串误判成 0', () => {
  assert.equal(lookupById(new Map([[0, 'zero']]), ''), undefined);
});

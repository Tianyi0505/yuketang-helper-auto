import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberUnlock, takeResolvableUnlocks } from '../src/state/pending-unlocks.js';

test('rememberUnlock 以字符串键暂存事件', () => {
  const store = new Map();
  assert.equal(rememberUnlock(store, 123, { prob: 123 }), true);
  assert.deepEqual(store.get('123'), { prob: 123 });
});

test('rememberUnlock 拒绝空题目 ID', () => {
  const store = new Map();
  for (const bad of [undefined, null, '', '   ']) {
    assert.equal(rememberUnlock(store, bad, {}), false);
  }
  assert.equal(store.size, 0);
});

test('rememberUnlock 对同一题目去重', () => {
  const store = new Map();
  rememberUnlock(store, 'p1', { v: 1 });
  rememberUnlock(store, 'p1', { v: 2 });
  assert.equal(store.size, 1);
  assert.deepEqual(store.get('p1'), { v: 2 });
});

test('takeResolvableUnlocks 仅取出已就绪项并移除', () => {
  const store = new Map([['a', { v: 'a' }], ['b', { v: 'b' }]]);
  const ready = takeResolvableUnlocks(store, (id) => id === 'a');
  assert.deepEqual(ready, [{ problemId: 'a', payload: { v: 'a' } }]);
  assert.deepEqual([...store.keys()], ['b'], '未就绪项应保留以待后续重放');
});

test('takeResolvableUnlocks 在无就绪项时返回空数组', () => {
  const store = new Map([['a', {}]]);
  assert.deepEqual(takeResolvableUnlocks(store, () => false), []);
  assert.equal(store.size, 1);
});

test('takeResolvableUnlocks 将 payload 传给判定函数', () => {
  const store = new Map();
  rememberUnlock(store, 'p1', { sid: 's1' });
  const seen = [];
  takeResolvableUnlocks(store, (id, payload) => {
    seen.push([id, payload]);
    return false;
  });
  assert.deepEqual(seen, [['p1', { sid: 's1' }]], '判定函数需同时拿到题目 ID 与原始事件');
});

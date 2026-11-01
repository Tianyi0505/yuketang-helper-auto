// src/state/pending-unlocks.js
/**
 * 自动进入的课堂不会触发站点自身的课件请求，题目解锁事件常常先于课件抵达。
 * 这里只负责暂存与取回，保持纯函数以便单测覆盖重放顺序。
 */

/** 暂存一条尚无法处理的解锁事件；缺少题目 ID 时返回 false。 */
export function rememberUnlock(store, problemId, payload) {
  if (problemId === undefined || problemId === null || String(problemId).trim() === '') {
    return false;
  }
  store.set(String(problemId), payload);
  return true;
}

/**
 * 取出当前已可处理的解锁事件（并从暂存区移除）。
 * isResolvable(problemId, payload) 由调用方判断题目与幻灯片是否已入库。
 */
export function takeResolvableUnlocks(store, isResolvable) {
  const ready = [];
  for (const [problemId, payload] of [...store]) {
    if (isResolvable(problemId, payload)) {
      store.delete(problemId);
      ready.push({ problemId, payload });
    }
  }
  return ready;
}

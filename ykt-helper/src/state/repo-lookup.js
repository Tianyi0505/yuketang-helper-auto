// src/state/repo-lookup.js
/**
 * 课件有两条载入路径，键的类型并不一致：
 * fetch 拦截器写入 String(slide.id)，而 onPresentationLoaded 写入原始 slide.id。
 * WebSocket 推送的 prob/sid 也可能是数字或字符串，
 * 因此按 ID 取值时需要同时容忍两种类型。
 */
export function lookupById(map, id) {
  if (!map || id === undefined || id === null) return undefined;
  if (map.has(id)) return map.get(id);

  const asString = String(id);
  if (map.has(asString)) return map.get(asString);

  if (asString.trim() !== '') {
    const asNumber = Number(asString);
    if (Number.isFinite(asNumber) && map.has(asNumber)) return map.get(asNumber);
  }
  return undefined;
}

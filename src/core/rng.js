// xorshift 系列种子随机数发生器 —— 主线程与 Worker 用同一种子独立重建同一张地图,
// 因此实现必须逐位一致,不可改动。

export function makeRng(seed) {
  let x = seed | 0 || 2654435769;
  let y = 608135816 ^ seed;
  let z = 3084996962;
  let w = (3735928559 + seed) | 0;
  function u32() {
    const t = w;
    const s = x;
    w = z;
    z = y;
    y = s;
    let v = t ^ (t << 11);
    v ^= v >>> 8;
    x = (v ^ s ^ (s >>> 19)) | 0;
    return x >>> 0;
  }
  for (let i = 0; i < 8; i++) u32(); // 预热,打散低质量初始状态
  return {
    u32,
    float: () => u32() / 4294967296,
    range: (lo, hi) => lo + (hi - lo) * (u32() / 4294967296),
  };
}

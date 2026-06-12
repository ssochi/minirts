// 模拟参数与兵种数值表 —— 主线程与模拟 Worker 共用的唯一事实来源。
// 任何改动都会同时影响渲染端预测与 Worker 端模拟,两端必须从本文件导入。

export const CONFIG = {
  maxUnits: 131072,
  mapW: 1600,
  mapH: 900,
  gridCell: 4,        // 占据网格(碰撞/SDF)单元尺寸,米
  flowCell: 8,        // 流场寻路单元尺寸,米
  unitRadius: 1.2,
  maxSpeed: 8,
  turnRate: 2.5,
  turretRate: 4,
  maxHp: 100,
  simHz: 15,          // 模拟 tick 频率;渲染端在两帧快照间插值
  attackRange: 36,
  cooldownTicks: 45,
  damage: 34,
  projectileSpeed: 80,
  specialMinArmy: 500, // 军队规模达到该值才开始混编特殊兵种
  giantEvery: 2500,    // 每 N 辆编入一辆巨型坦克
  mix: { scout: 0.12, mlrs: 0.03, destroyer: 0.05, drone: 0.08 },
  separationRadius: 2.8,
  wallAvoidDist: 4,
  neighborCap: 8,
  marchFlowDist: 120,  // 距目标超过该距离时走流场,否则直接寻的
  retargetBuckets: 8,  // 分桶轮询重新索敌,摊薄每 tick 开销
  flowRefreshTicks: 4,
  eventCapacity: 4096, // 事件环形缓冲容量(SHOT/DEATH/...)
  defaultRed: 3e4,
  defaultBlue: 3e4,
  seed: 1337,
};

export const TICK_DT = 1 / CONFIG.simHz;

// 兵种编号(快照 meta 与几何工厂数组的索引)
export const KIND = {
  MBT: 0,        // 主战坦克
  GIANT: 1,      // 巨型坦克
  SCOUT: 2,      // 侦察车
  MLRS: 3,       // 火箭炮车
  DESTROYER: 4,  // 磁轨歼击车
  DRONE: 5,      // 攻击无人机
};

// 每兵种数值。kite: 敌近时倒车保距系数;hitRun: 打了就跑;
// muzzle: 炮口距炮塔轴心的前向距离,米;volley: 一次齐射弹数。
export const KIND_STATS = [
  { radius: 1.2, hp: 100,  speed: 8,   turn: 1.9, turretRate: 1.5,  range: 36, cooldown: 45, damage: 34,  projSpeed: 80,  aoe: 0,  volley: 1, fly: 0, kite: 0,    hitRun: 0, muzzle: 3.4 },
  { radius: 3,   hp: 1e3,  speed: 6,   turn: 0.8, turretRate: 0.55, range: 70, cooldown: 90, damage: 130, projSpeed: 55,  aoe: 14, volley: 1, fly: 0, kite: 0,    hitRun: 0, muzzle: 9.3 },
  { radius: 1,   hp: 36,   speed: 15,  turn: 4,   turretRate: 3,    range: 28, cooldown: 15, damage: 8,   projSpeed: 95,  aoe: 0,  volley: 1, fly: 0, kite: 0,    hitRun: 1, muzzle: 1.2 },
  { radius: 1.4, hp: 70,   speed: 7,   turn: 1.6, turretRate: 0.9,  range: 58, cooldown: 80, damage: 26,  projSpeed: 42,  aoe: 6,  volley: 6, fly: 0, kite: 0.5,  hitRun: 0, muzzle: 1.3 },
  { radius: 1.3, hp: 60,   speed: 7.5, turn: 1.6, turretRate: 1.2,  range: 55, cooldown: 55, damage: 85,  projSpeed: 300, aoe: 0,  volley: 1, fly: 0, kite: 0.55, hitRun: 0, muzzle: 3.6 },
  { radius: 0.9, hp: 30,   speed: 16,  turn: 3,   turretRate: 6,    range: 30, cooldown: 27, damage: 13,  projSpeed: 95,  aoe: 0,  volley: 1, fly: 1, kite: 0,    hitRun: 0, muzzle: 0.5 },
];

export const KIND_FLY = new Uint8Array(KIND_STATS.map((s) => s.fly));

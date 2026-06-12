// 模型工厂汇总:按 KIND(0=mbt 1=giant 2=scout 3=mlrs 4=destroyer 5=drone)
// 索引的车体/炮塔构建器数组,以及炮塔系炮口偏移表 MUZZLE_OFFSETS(原 Ng..Lg)。
import { Vector3 } from 'three';
import { buildMbtHull, buildMbtTurret, buildPlainMbtHull } from './mbt.js';
import { buildGiantHull, buildGiantTurret } from './giant.js';
import { buildScoutHull, buildScoutTurret } from './scout.js';
import { buildMlrsHull, buildMlrsLauncher } from './mlrs.js';
import { buildDestroyerHull, buildDestroyerGun } from './destroyer.js';
import { buildDroneBody } from './drone.js';

// 车体构建器,按 KIND 索引
export const HULL_BUILDERS = [
  buildMbtHull,
  buildGiantHull,
  buildScoutHull,
  buildMlrsHull,
  buildDestroyerHull,
  buildDroneBody,
];

// 炮塔构建器,按 KIND 索引(无人机无炮塔)
export const TURRET_BUILDERS = [
  buildMbtTurret,
  buildGiantTurret,
  buildScoutTurret,
  buildMlrsLauncher,
  buildDestroyerGun,
  null,
];

// 炮口相对炮塔原点的本地偏移(索引 0..4;无人机无炮塔故不在表内)
export const MUZZLE_OFFSETS = [
  new Vector3(0.15, 1.26, 0),   // mbt
  new Vector3(0.35, 2.82, 0),   // giant
  new Vector3(-0.15, 1.32, 0),  // scout
  new Vector3(-0.35, 1.45, 0),  // mlrs
  new Vector3(0.1, 1.15, 0),    // destroyer
];

export {
  buildMbtHull,
  buildMbtTurret,
  buildPlainMbtHull,
  buildGiantHull,
  buildGiantTurret,
  buildScoutHull,
  buildScoutTurret,
  buildMlrsHull,
  buildMlrsLauncher,
  buildDestroyerHull,
  buildDestroyerGun,
  buildDroneBody,
};

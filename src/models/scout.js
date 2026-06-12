// 侦察车(SCOUT, KIND 2)几何工厂:四轮轻型车体 + 机枪小炮塔。
// 车轮用本地辅助函数直接构造圆柱(aAnim 1 = 自转)。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CylinderGeometry } from 'three';
import { TILE } from '../render/atlas/tiles.js';
import { box, cyl, tileCylinder, paintPart, setAnim } from './parts.js';

export function buildScoutHull(hi = true) {
  // 车轮(x, z):半径 0.44,轮心高 0.44
  const wheel = (x, z) =>
    setAnim(
      paintPart(
        tileCylinder(new CylinderGeometry(0.44, 0.44, 0.32, 10), TILE.DARK, TILE.WHEEL)
          .rotateX(Math.PI / 2)
          .translate(x, 0.44, z),
        0,
        0.85,
      ),
      1,
      x,
      0.44,
      0.44,
    );
  const parts = [
    // 车体 / 首部斜板 / 后部格栅舱 / 引擎盖格栅
    box(2.9, 0.55, 1.55, 0, 0.95, 0, 1, 1, 0, 0, 0, 0, { top: TILE.PLATE2, side: TILE.SIDE }),
    box(0.95, 0.32, 1.4, 1.45, 1, 0, 2, 1.1, -0.5),
    box(1.3, 0.35, 1.45, -0.7, 1.3, 0, 2, 0.85, 0, 0, 0, 0, { top: TILE.GRID }),
    box(0.6, 0.06, 1.5, 0.55, 1.26, 0, 1, 0.95, 0, 0, 0, 0, { top: TILE.GRILLE }),
    // 车轮 ×4
    wheel(0.95, 0.95),
    wheel(0.95, -0.95),
    wheel(-0.95, 0.95),
    wheel(-0.95, -0.95),
  ];
  if (hi) {
    // 轮毂 ×4
    for (const [x, z] of [
      [0.95, 0.95],
      [0.95, -0.95],
      [-0.95, 0.95],
      [-0.95, -0.95],
    ])
      parts.push(cyl(0.16, 0.36, 6, x, 0.44, z, 1, 0.9, Math.PI / 2));
    // 尾部备胎
    parts.push(cyl(0.4, 0.22, 10, -1.62, 1.05, 0, 0, 0.85, 0, Math.PI / 2, 0, TILE.DARK, TILE.WHEEL));
    for (const side of [1, -1]) {
      // 前保险杠立柱 + 侧踏板 + 前灯
      parts.push(box(0.08, 0.22, 0.3, 1.95, 0.78, 0.55 * side, 0, 0.55));
      parts.push(box(1.6, 0.07, 0.16, 0.1, 0.62, 0.86 * side, 0, 0.5));
      parts.push(box(0.1, 0.1, 0.14, 1.92, 1.06, 0.5 * side, 0, 1, 0, 0, 0.35));
    }
    // 顶部仪器 / 天线 / 顶板 / 物资箱 / 斜置短杆 / 侧窗板 / 后视镜 ×2 / 斜顶板
    parts.push(box(0.5, 0.07, 0.2, -0.55, 1.51, 0, 0, 1, 0, 0, 0.5));
    parts.push(box(0.035, 0.8, 0.035, -1.2, 1.75, 0.6, 0, 0.5));
    parts.push(box(1.1, 0.06, 1.2, -0.65, 1.5, 0, 0, 0.5));
    parts.push(box(0.5, 0.16, 0.4, -0.6, 1.56, 0.2, 1, 0.95, 0, 0, 0, 0, { all: TILE.CRATE }));
    parts.push(cyl(0.07, 0.7, 6, -1.35, 0.85, -0.5, 0, 0.45, 0, 0.5));
    parts.push(box(0.06, 0.5, 0.7, 1.05, 1.05, 0.79, 0, 0.4));
    parts.push(box(0.06, 0.34, 0.06, 1.7, 1.35, 0.65, 0, 0.5, 0, -0.4));
    parts.push(box(0.06, 0.34, 0.06, 1.7, 1.35, -0.65, 0, 0.5, 0, 0.4));
    parts.push(box(0.05, 0.42, 1.5, -0.25, 1.52, 0, 0, 0.55, 0.5));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

export function buildScoutTurret(hi = true) {
  const parts = [
    // 枪座 / 枪管 / 观瞄块
    box(0.7, 0.3, 0.6, -0.05, 0.13, 0, 1, 0.95),
    box(1.05, 0.09, 0.09, 0.6, 0.22, 0, 0, 0.7),
    box(0.18, 0.22, 0.18, -0.3, 0.32, 0, 0, 0.6),
  ];
  if (hi) {
    // 弹箱 / 消焰器 / 顶部护板
    parts.push(box(0.26, 0.18, 0.16, -0.05, 0.2, 0.36, 0, 0.5));
    parts.push(box(0.1, 0.06, 0.06, 1.15, 0.22, 0, 0, 0.45));
    parts.push(box(0.3, 0.04, 0.5, -0.05, 0.32, -0.2, 1, 1.05));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

// 巨型坦克(GIANT, KIND 1)几何工厂:四履带超重型车体 + 长身管巨炮塔。
// hi=true 附加高模细节(裙板肋条/进气筒/侧裙挂块/通气栅等)。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE } from '../render/atlas/tiles.js';
import { box, cyl, gunBarrel, setAnim } from './parts.js';

export function buildGiantHull(hi = true) {
  const parts = [
    // 履带 ×4(双联,aAnim 3)
    setAnim(
      box(10, 1.5, 1.05, 0, 0.85, 2.62, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    setAnim(
      box(10, 1.5, 1.05, 0, 0.85, 1.5, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    setAnim(
      box(10, 1.5, 1.05, 0, 0.85, -2.62, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    setAnim(
      box(10, 1.5, 1.05, 0, 0.85, -1.5, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    // 侧裙板 ×2
    box(10.3, 1.1, 0.2, 0, 1.45, 3.22, 2, 0.78, 0, 0, 0, 0, { side: TILE.SIDE }),
    box(10.3, 1.1, 0.2, 0, 1.45, -3.22, 2, 0.78, 0, 0, 0, 0, { side: TILE.SIDE }),
    // 下车体 / 上车体
    box(9.6, 1.2, 4, 0, 1.35, 0, 1, 0.85),
    box(8.8, 0.95, 5.9, -0.3, 2.32, 0, 1, 1, 0, 0, 0, 0, { top: TILE.PLATE2, side: TILE.SIDE }),
    // 首上斜甲 / 车首 / 尾部斜板
    box(2.7, 0.4, 5.6, 4.45, 2.05, 0, 1, 1.12, -0.55),
    box(1.4, 1.1, 4, 4.85, 1.15, 0, 1, 0.82),
    box(2, 0.32, 5.6, -4.55, 2.1, 0, 1, 0.9, 0.5),
    // 发动机盖
    box(3.4, 0.28, 5.4, -2.7, 2.92, 0, 1, 0.95, 0, 0, 0, 0, { top: TILE.ENGINE }),
    // 排气塔 ×2
    box(0.65, 1.7, 0.65, -4.3, 3.4, 1.95, 0, 0.85, 0, 0, 0, 0, { side: TILE.EXHAUST, end: TILE.EXHAUST, top: TILE.DARK }),
    box(0.65, 1.7, 0.65, -4.3, 3.4, -1.95, 0, 0.85, 0, 0, 0, 0, { side: TILE.EXHAUST, end: TILE.EXHAUST, top: TILE.DARK }),
    // 尾部散热板 ×2(extra=1)
    box(1.9, 0.12, 0.8, -2.7, 3.07, 1.6, 0, 1, 0, 0, 1),
    box(1.9, 0.12, 0.8, -2.7, 3.07, -1.6, 0, 1, 0, 0, 1),
  ];
  if (hi) {
    for (const side of [1, -1]) {
      // 裙板肋条 ×6 + 侧顶踏板 + 前灯 + 侧灯
      for (let i = 0; i < 6; i++) parts.push(box(0.22, 0.95, 0.08, -4.2 + i * 1.7, 1.45, 3.34 * side, 1, 0.65));
      parts.push(box(2.2, 0.1, 0.55, 0.4, 2.86, 2.6 * side, 0, 0.8, 0, 0, 0, 0, { top: TILE.TREAD, side: TILE.DARK }));
      parts.push(box(0.2, 0.18, 0.26, 5.05, 2.4, 1.7 * side, 0, 1, 0, 0, 0.35));
      parts.push(box(0.24, 0.2, 0.18, 5.1, 1.6, 0.9 * side, 0, 0.5));
    }
    // 发动机盖格栅条 ×4
    for (let i = 0; i < 4; i++) parts.push(box(3.2, 0.05, 0.14, -2.7, 3, -1 + i * 0.66, 0, 0.45));
    // 进气筒
    parts.push(cyl(0.3, 1.6, 8, 4.6, 2.75, 0, 1, 0.85, Math.PI / 2, 0, 0, TILE.DARK, TILE.INTAKE));
    for (const side of [1, -1]) {
      // 侧裙挂块 ×7 + 首部牵引钩
      for (let i = 0; i < 7; i++) parts.push(box(0.55, 0.22, 1.1, -3.9 + i * 1.3, 1.68, 2.62 * side, 0, 0.3));
      parts.push(box(0.5, 0.4, 0.4, 3.6, 2.62, 2.4 * side, 0, 1, 0, 0, 0.5));
    }
    // 尾部通气箱 + 把手
    parts.push(box(1.6, 0.5, 2.6, -3.9, 2.62, 0, 1, 0.95, 0, 0, 0, 0, { side: TILE.VENTS, top: TILE.ENGINE, end: TILE.VENTS }));
    parts.push(box(1.4, 0.1, 0.1, -4.65, 2.62, 0.6, 0, 0.55));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

export function buildGiantTurret(hi = true) {
  const parts = [
    // 炮塔主体 + 两侧楔形附甲 + 顶甲板
    box(4.4, 1.15, 3.5, -0.35, 0.55, 0, 2, 1, 0, 0, 0, 0, { top: TILE.TURRET, side: TILE.PLATE2, end: TILE.PLATE2 }),
    box(3.9, 1.05, 0.75, -0.3, 0.55, 1.95, 2, 0.93, 0, -0.5),
    box(3.9, 1.05, 0.75, -0.3, 0.55, -1.95, 2, 0.93, 0, 0.5),
    box(3, 0.22, 2.5, -0.5, 1.2, 0, 2, 1.06, 0, 0, 0, 0, { top: TILE.TURRET }),
    // 防盾
    box(1.05, 1.05, 1.5, 1.95, 0.5, 0, 1, 0.88),
    // 巨炮:主身管 + 两段套筒 + 炮口块
    gunBarrel(0.22, 6.4, 5.4, 0.62, 0, 0.8),
    gunBarrel(0.34, 0.9, 3.4, 0.62, 0, 0.7),
    gunBarrel(0.32, 0.7, 5.6, 0.62, 0, 0.7),
    box(1, 0.62, 0.62, 8.5, 0.62, 0, 0, 0.6),
    // 防盾上方鳍板 ×2(extra=1)
    box(0.09, 0.2, 0.55, 2.55, 0.95, 1.35, 0, 1, 0, 0, 1),
    box(0.09, 0.2, 0.55, 2.55, 0.95, -1.35, 0, 1, 0, 0, 1),
    // 尾舱 + 尾板(extra=1)
    box(1.5, 0.85, 3, -2.7, 0.5, 0, 1, 0.85),
    box(0.12, 0.55, 2.1, -3.5, 0.55, 0, 0, 1, 0, 0, 1),
    // 舱口 + 顶部滑轨 + 天线 ×2
    box(0.95, 0.38, 0.95, -1.15, 1.42, 0.85, 1, 0.9, 0, 0, 0, 0, { top: TILE.HATCH }),
    box(1.2, 0.14, 0.14, -0.5, 1.6, 0.85, 0, 0.7),
    box(0.05, 1.5, 0.05, -2.4, 2, 1.3, 0, 0.5),
    box(0.05, 1.2, 0.05, -2.6, 1.85, -1.2, 0, 0.5),
  ];
  if (hi) {
    for (const side of [1, -1]) {
      // 烟幕弹发射器 ×4 + 侧面小件 ×2
      for (let i = 0; i < 4; i++) parts.push(box(0.14, 0.14, 0.4, 1.1 + i * 0.28, 0.95, 2.05 * side, 0, 0.55, 0, side * 0.5));
      parts.push(box(0.22, 0.1, 0.5, -1.6, 1.32, 1.5 * side, 1, 1.1));
      parts.push(box(0.5, 0.22, 0.3, -2.6, 1, 1.7 * side, 1, 0.85));
    }
    // 顶部观瞄塔 + 机枪 + 仪器箱
    parts.push(box(0.55, 0.3, 0.6, 0.3, 1.45, -0.9, 1, 0.95));
    parts.push(box(0.9, 0.09, 0.09, 0.95, 1.55, -0.9, 0, 0.6));
    parts.push(box(0.4, 0.16, 0.28, 0.55, 1.4, 0.3, 0, 0.55));
    // 防盾两侧液压筒 ×2 + 炮身套环
    parts.push(cyl(0.4, 0.5, 8, 3.9, 0.62, 1.1, 0, 0.45, 0, Math.PI / 2));
    parts.push(cyl(0.4, 0.5, 8, 3.9, 0.62, -1.1, 0, 0.45, 0, Math.PI / 2));
    parts.push(cyl(0.3, 0.95, 8, 6.8, 0.62, 0, 1, 0.7, 0, Math.PI / 2));
    // 第二排烟幕弹发射器 ×4×2
    for (const side of [1, -1])
      for (let i = 0; i < 4; i++) parts.push(box(0.16, 0.16, 0.42, 1.35 + i * 0.3, 1, 2.1 * side, 0, 0.55, 0, side * 0.5));
    // 顶部雷达基座 + 桅杆 + 雷达头
    parts.push(box(0.8, 0.55, 0.55, -2, 1.55, -0.5, 1, 0.9));
    parts.push(cyl(0.1, 0.9, 6, -2, 2.25, -0.5, 0, 0.55));
    parts.push(box(0.28, 0.22, 0.34, -2, 2.75, -0.5, 0, 1, 0, 0, 0.6));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

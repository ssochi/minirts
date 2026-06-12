// 主战坦克(MBT, KIND 0)几何工厂:车体 + 炮塔。
// hi=true 附加高模细节(负重轮/烟幕弹/工具箱/天线等);buildPlainMbtHull 为残骸用低模车体。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE } from '../render/atlas/tiles.js';
import { box, cyl, gunBarrel, setAnim } from './parts.js';

export function buildMbtHull(hi = true) {
  const parts = [
    // 履带 ×2(aAnim 3 = 履带滚动)
    setAnim(
      box(4.6, 0.7, 0.62, 0, 0.42, 1.16, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    setAnim(
      box(4.6, 0.7, 0.62, 0, 0.42, -1.16, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    // 翼子板 ×2
    box(4.4, 0.06, 0.66, 0, 0.81, 1.16, 2, 0.7),
    box(4.4, 0.06, 0.66, 0, 0.81, -1.16, 2, 0.7),
    // 下车体 / 上车体
    box(4.3, 0.5, 1.7, 0, 0.62, 0, 1, 0.85),
    box(4, 0.42, 2.25, -0.15, 1.05, 0, 1, 1, 0, 0, 0, 0, { top: TILE.PLATE2, side: TILE.SIDE }),
    // 首上斜甲 / 尾部斜板
    box(1.15, 0.16, 2.2, 1.92, 0.97, 0, 1, 1.12, -0.6, 0, 0, 0, { top: TILE.PLATE2 }),
    box(0.85, 0.14, 2.2, -2, 0.97, 0, 1, 0.9, 0.5),
    // 发动机盖
    box(1.5, 0.1, 1.9, -1.15, 1.3, 0, 1, 0.95, 0, 0, 0, 0, { top: TILE.ENGINE }),
    // 排气管 ×2
    box(0.5, 0.2, 0.26, -1.7, 0.95, 1, 0, 0.85, 0, 0, 0, 0, { all: TILE.EXHAUST }),
    box(0.5, 0.2, 0.26, -1.7, 0.95, -1, 0, 0.85, 0, 0, 0, 0, { all: TILE.EXHAUST }),
  ];
  if (hi) {
    for (const side of [1, -1]) {
      // 负重轮 ×5(aAnim 1 = 自转)
      for (let i = 0; i < 5; i++)
        parts.push(
          setAnim(
            cyl(0.34, 0.55, 8, -1.6 + i * 0.8, 0.38, 1.16 * side, 0, 0.85, Math.PI / 2, 0, 0, TILE.DARK, TILE.WHEEL),
            1,
            -1.6 + i * 0.8,
            0.38,
            0.34,
          ),
        );
      // 侧挂物资箱 + 车前灯 + 车侧灯
      parts.push(box(0.85, 0.18, 0.52, -1.15, 0.95, 1.16 * side, 1, 0.95, 0, 0, 0, 0, { all: TILE.CRATE }));
      parts.push(box(0.14, 0.13, 0.2, 2.28, 1.02, 0.72 * side, 0, 1, 0, 0, 0.35));
      parts.push(box(0.16, 0.14, 0.12, 2.32, 0.66, 0.45 * side, 0, 0.5));
    }
    // 首上备用履带板 + 尾部横置圆筒
    parts.push(box(0.5, 0.06, 1.25, 1.78, 1.16, 0, 0, 0.8, -0.6, 0, 0, 0, { top: TILE.TREAD }));
    parts.push(cyl(0.13, 1.5, 6, -2.18, 1.18, 0, 1, 0.62, Math.PI / 2));
    for (const side of [1, -1]) {
      // 侧裙加强块 ×5
      for (let i = 0; i < 5; i++) parts.push(box(0.3, 0.1, 0.66, -1.72 + i * 0.86, 0.8, 1.16 * side, 0, 0.6));
      // 主动轮 / 诱导轮(aAnim 1)
      parts.push(
        setAnim(cyl(0.3, 0.18, 8, 2.18, 0.45, 1.16 * side, 0, 0.85, Math.PI / 2, 0, 0, TILE.DARK, TILE.WHEEL), 1, 2.18, 0.45, 0.3),
      );
      parts.push(
        setAnim(cyl(0.26, 0.18, 8, -2.2, 0.42, 1.16 * side, 0, 0.85, Math.PI / 2, 0, 0, TILE.DARK, TILE.WHEEL), 1, -2.2, 0.42, 0.26),
      );
    }
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

export function buildMbtTurret(hi = true) {
  const parts = [
    // 炮塔主体 + 两侧楔形附甲
    box(1.8, 0.45, 1.35, -0.1, 0.22, 0, 2, 1, 0, 0, 0, 0, { top: TILE.TURRET, side: TILE.PLATE2, end: TILE.PLATE2 }),
    box(1.6, 0.42, 0.34, -0.05, 0.24, 0.76, 2, 0.93, 0, -0.55),
    box(1.6, 0.42, 0.34, -0.05, 0.24, -0.76, 2, 0.93, 0, 0.55),
    // 防盾
    box(0.5, 0.4, 0.62, 0.85, 0.22, 0, 1, 0.88),
    // 主炮 + 炮口制退器
    gunBarrel(0.09, 2.4, 2, 0.3, 0, 0.8),
    box(0.34, 0.21, 0.21, 3.06, 0.3, 0, 0, 0.65),
    // 尾舱物资筐
    box(0.62, 0.32, 1.05, -1.06, 0.2, 0, 1, 0.95, 0, 0, 0, 0, { all: TILE.CRATE }),
    // 舱口 ×2 + 天线
    box(0.5, 0.16, 0.5, -0.38, 0.52, 0.32, 1, 0.9, 0, 0, 0, 0, { top: TILE.HATCH }),
    box(0.42, 0.06, 0.42, -0.32, 0.48, -0.42, 1, 1.15, 0, 0, 0, 0, { top: TILE.HATCH }),
    box(0.035, 0.95, 0.035, -0.85, 0.85, 0.55, 0, 0.5),
  ];
  if (hi) {
    // 座圈
    parts.push(cyl(0.8, 0.1, 10, -0.05, -0.04, 0, 1, 0.72));
    for (const side of [1, -1]) {
      // 烟幕弹发射器 ×3 + 侧面小件 ×2
      for (let i = 0; i < 3; i++) parts.push(box(0.09, 0.09, 0.24, 0.5 + i * 0.17, 0.34, 0.82 * side, 0, 0.55, 0, side * 0.5));
      parts.push(box(0.16, 0.07, 0.1, 0.28, 0.49, 0.3 * side, 0, 0.55));
      parts.push(box(0.1, 0.05, 0.2, -0.55, 0.46, 0.6 * side, 1, 1.1));
    }
    // 顶部机枪 / 观瞄 / 侧筐 / 炮口套环 / 顶板 / 横杆 / 抽气装置
    parts.push(box(0.5, 0.06, 0.06, 0.05, 0.66, 0.34, 0, 0.6));
    parts.push(box(0.14, 0.12, 0.12, -0.2, 0.62, 0.34, 0, 0.5));
    parts.push(box(0.3, 0.1, 0.55, -1.05, 0.42, 0.45, 1, 0.95, 0, 0, 0, 0, { all: TILE.CRATE }));
    parts.push(cyl(0.13, 0.22, 6, 2.55, 0.3, 0, 0, 0.5, 0, Math.PI / 2));
    parts.push(box(0.55, 0.1, 0.3, 0.3, 0.47, 0, 0, 0.5));
    parts.push(box(0.9, 0.05, 0.05, -1, 0.4, -0.45, 1, 0.7));
    parts.push(cyl(0.13, 0.45, 6, 2.05, 0.3, 0, 1, 0.7, 0, Math.PI / 2));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

// 残骸用低模车体(= buildMbtHull(false))
export function buildPlainMbtHull() {
  return buildMbtHull(false);
}

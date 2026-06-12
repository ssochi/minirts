// 火箭炮车(MLRS, KIND 3)几何工厂:履带车体 + 可仰起的 2×3 发射箱。
// 发射箱部件先在本地系平移,再绕 Z 仰起 elev=0.42,最后挂到基座(-0.15, 0.62, 0)。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { BoxGeometry, CylinderGeometry } from 'three';
import { TILE } from '../render/atlas/tiles.js';
import { box, cyl, tileBox, tileCylinder, paintPart, setAnim } from './parts.js';

export function buildMlrsHull(hi = true) {
  const parts = [
    // 履带 ×2(aAnim 3)
    setAnim(
      box(4.3, 0.75, 0.6, 0, 0.45, 1.05, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    setAnim(
      box(4.3, 0.75, 0.6, 0, 0.45, -1.05, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    // 车体 / 驾驶舱(前风挡 GLASS)/ 首部斜板 / 后部格栅平台
    box(4, 0.6, 1.7, 0, 0.85, 0, 1, 0.88),
    box(1.2, 0.55, 1.9, 1.35, 1.3, 0, 1, 1.05, 0, 0, 0, 0, { end: TILE.GLASS, top: TILE.PLATE2 }),
    box(0.7, 0.25, 1.7, 1.95, 1.15, 0, 1, 1.1, -0.5),
    box(1.9, 0.18, 1.85, -0.9, 1.25, 0, 1, 0.8, 0, 0, 0, 0, { top: TILE.GRID }),
  ];
  if (hi) {
    for (const side of [1, -1]) {
      // 负重轮 ×4(aAnim 1)
      for (let i = 0; i < 4; i++)
        parts.push(
          setAnim(
            cyl(0.3, 0.5, 6, -1.5 + i * 1, 0.42, 1.05 * side, 0, 0.85, Math.PI / 2, 0, 0, TILE.DARK, TILE.WHEEL),
            1,
            -1.5 + i * 1,
            0.42,
            0.3,
          ),
        );
      // 尾部挡泥板 + 侧挂物资箱
      parts.push(box(0.16, 0.5, 0.3, -1.95, 0.62, 0.95 * side, 0, 0.55, 0, 0.5));
      parts.push(box(0.9, 0.2, 0.2, 0.3, 0.98, 0.98 * side, 1, 0.95, 0, 0, 0, 0, { all: TILE.CRATE }));
    }
    // 驾驶舱顶罩 + 前灯 ×2
    parts.push(box(0.62, 0.3, 1.5, 1.62, 1.42, 0, 0, 0.45));
    parts.push(box(0.1, 0.1, 0.14, 2.28, 1, 0.6, 0, 1, 0, 0, 0.35));
    parts.push(box(0.1, 0.1, 0.14, 2.28, 1, -0.6, 0, 1, 0, 0, 0.35));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

export function buildMlrsLauncher(hi = true) {
  const elev = 0.42; // 发射箱仰角
  const parts = [
    // 回转基座 + 发射箱主体(随仰角)
    box(0.7, 0.35, 1.1, 0, 0.1, 0, 1, 0.9),
    box(2.3, 0.75, 1.7, -0.15, 0.62, 0, 2, 0.95, elev, 0, 0, 0, { side: TILE.SIDE, top: TILE.PLATE2 }),
  ];
  // 发射管 2×3:管体 + 管口框
  for (let row = 0; row < 2; row++)
    for (let col = 0; col < 3; col++) {
      const tube = tileBox(new BoxGeometry(0.28, 0.3, 0.34), { all: TILE.DARK })
        .translate(1.08, (row - 0.5) * 0.38, (col - 1) * 0.54)
        .rotateZ(elev)
        .translate(-0.15, 0.62, 0);
      parts.push(paintPart(tube, 0, 0.45));
      const rim = tileBox(new BoxGeometry(0.06, 0.22, 0.26), { all: TILE.DARK })
        .translate(1.23, (row - 0.5) * 0.38, (col - 1) * 0.54)
        .rotateZ(elev)
        .translate(-0.15, 0.62, 0);
      parts.push(paintPart(rim, 0, 0.2));
    }
  if (hi) {
    // 发射箱侧导轨 ×2(随仰角)
    for (const side of [1, -1]) {
      const rail = tileBox(new BoxGeometry(2.2, 0.1, 0.1), { all: TILE.DARK })
        .translate(-0.2, -0.45, side * 0.88)
        .rotateZ(elev)
        .translate(-0.15, 0.62, 0);
      parts.push(paintPart(rail, 0, 0.6));
    }
    // 液压撑杆 + 基座物资箱 + 尾部挡焰板
    parts.push(box(0.12, 0.55, 0.12, 0.45, 0.18, 0.5, 0, 0.5, elev / 2));
    parts.push(box(0.3, 0.18, 0.4, -0.5, 0.06, -0.5, 1, 0.95, 0, 0, 0, 0, { all: TILE.CRATE }));
    parts.push(box(0.08, 0.9, 1.5, -1.15, 0.45, 0, 1, 0.78, 0.25));
    // 火箭弹头锥 2×3(extra=0.35)
    for (let row = 0; row < 2; row++)
      for (let col = 0; col < 3; col++) {
        const tip = tileCylinder(new CylinderGeometry(0.02, 0.11, 0.22, 4), TILE.DARK, TILE.DARK)
          .rotateZ(-Math.PI / 2)
          .translate(1.28, (row - 0.5) * 0.38, (col - 1) * 0.54)
          .rotateZ(elev)
          .translate(-0.15, 0.62, 0);
        parts.push(paintPart(tip, 0, 1, 0.35));
      }
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

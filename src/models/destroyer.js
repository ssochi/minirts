// 磁轨歼击车(DESTROYER, KIND 4)几何工厂:低矮履带车体 + 细长磁轨炮。
// 磁轨炮带双导轨条与加速线圈环(extra=0.8 的发光环)。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TILE } from '../render/atlas/tiles.js';
import { box, cyl, setAnim } from './parts.js';

export function buildDestroyerHull(hi = true) {
  const parts = [
    // 履带 ×2(aAnim 3)
    setAnim(
      box(4.5, 0.65, 0.58, 0, 0.4, 1.12, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    setAnim(
      box(4.5, 0.65, 0.58, 0, 0.4, -1.12, 0, 0.9, 0, 0, 0, 0, { side: TILE.TREAD, end: TILE.TREAD, top: TILE.DARK }),
      3,
      0,
      0,
      1 / 1.5,
    ),
    // 下车体 / 上车体 / 首上斜甲
    box(4.2, 0.55, 1.75, 0, 0.75, 0, 1, 0.9),
    box(3.4, 0.35, 2.1, -0.2, 1.05, 0, 2, 1, 0, 0, 0, 0, { top: TILE.PLATE2, side: TILE.SIDE }),
    box(1.2, 0.2, 2, 1.7, 0.98, 0, 1, 1.1, -0.45),
    // 天线 + 尾部散热板(extra=1)
    box(0.08, 0.9, 0.08, -1.7, 1.7, 0.7, 0, 0.5),
    box(0.55, 0.1, 1.6, -1.5, 1.26, 0, 0, 1, 0, 0, 1),
  ];
  if (hi) {
    for (const side of [1, -1]) {
      // 负重轮 ×5(aAnim 1)
      for (let i = 0; i < 5; i++)
        parts.push(
          setAnim(
            cyl(0.3, 0.5, 6, -1.7 + i * 0.85, 0.38, 1.12 * side, 0, 0.85, Math.PI / 2, 0, 0, TILE.DARK, TILE.WHEEL),
            1,
            -1.7 + i * 0.85,
            0.38,
            0.3,
          ),
        );
      // 前灯
      parts.push(box(0.1, 0.1, 0.14, 2.32, 0.95, 0.6 * side, 0, 1, 0, 0, 0.35));
    }
    // 尾部散热鳍条 ×4
    for (let i = 0; i < 4; i++) parts.push(box(0.5, 0.16, 0.05, -1.5, 1.12, -0.5 + i * 0.33, 0, 0.45));
    // 顶部通气板 + 两侧能量导管(extra=0.6)
    parts.push(box(0.7, 0.1, 1.7, 0.2, 1.24, 0, 1, 0.92, 0, 0, 0, 0, { top: TILE.VENTS }));
    parts.push(box(2, 0.07, 0.05, 0.2, 0.95, 0.9, 0, 1, 0, 0, 0.6));
    parts.push(box(2, 0.07, 0.05, 0.2, 0.95, -0.9, 0, 1, 0, 0, 0.6));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

export function buildDestroyerGun(hi = true) {
  const parts = [
    // 炮座 / 磁轨主梁 / 双导轨条(extra=1 发光)
    box(1.5, 0.45, 1.2, -0.2, 0.2, 0, 1, 0.95),
    box(3.4, 0.16, 0.34, 1.7, 0.32, 0, 0, 0.75),
    box(3.1, 0.07, 0.06, 1.65, 0.32, 0.21, 0, 1, 0, 0, 1),
    box(3.1, 0.07, 0.06, 1.65, 0.32, -0.21, 0, 1, 0, 0, 1),
    // 炮口块 / 后膛块
    box(0.4, 0.3, 0.5, 3.3, 0.32, 0, 0, 0.6),
    box(0.45, 0.4, 0.6, 0.55, 0.32, 0, 0, 0.7),
  ];
  if (hi) {
    // 加速线圈环 ×3
    for (let i = 0; i < 3; i++) parts.push(cyl(0.26, 0.14, 8, 1.2 + i * 0.75, 0.32, 0, 0, 0.55, 0, Math.PI / 2));
    // 下方线缆 + 尾部配重 + 观瞄块
    parts.push(box(2.6, 0.06, 0.08, 1.5, 0.18, 0.12, 0, 0.4));
    parts.push(box(0.5, 0.3, 0.45, -0.85, 0.25, 0, 1, 0.8));
    parts.push(box(0.2, 0.16, 0.2, 0.1, 0.5, 0.4, 0, 0.55));
    // 线圈发光环 ×3(extra=0.8)
    for (let i = 0; i < 3; i++) parts.push(cyl(0.2, 0.05, 8, 1.58 + i * 0.75, 0.32, 0, 0, 1, 0, Math.PI / 2, 0.8));
    // 顶部护板 + 小天线
    parts.push(box(0.34, 0.1, 0.55, -0.4, 0.5, 0, 1, 0.95));
    parts.push(box(0.07, 0.34, 0.07, -0.75, 0.62, -0.3, 0, 0.5));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

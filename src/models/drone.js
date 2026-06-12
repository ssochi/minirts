// 攻击无人机(DRONE, KIND 5)几何工厂:四旋翼机体(无独立炮塔)。
// 旋翼用本地辅助函数构造(aAnim 2 = 旋翼,转速 ±26 按象限定向)。
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CylinderGeometry } from 'three';
import { TILE } from '../render/atlas/tiles.js';
import { box, cyl, tileCylinder, paintPart, setAnim } from './parts.js';

export function buildDroneBody(hi = true) {
  // 旋翼盘(x, z):FAN 瓦片端盖,对角同向旋转
  const rotor = (x, z) =>
    setAnim(
      paintPart(tileCylinder(new CylinderGeometry(0.58, 0.58, 0.05, 12), TILE.DARK, TILE.FAN).translate(x, 0.18, z), 0, 0.85),
      2,
      x,
      z,
      (x * z > 0 ? 1 : -1) * 26,
    );
  const parts = [
    // 机身 / 前传感器(extra=1)/ 尾部块 / X 形机臂 ×2
    box(1, 0.34, 0.55, 0, 0, 0, 2, 1, 0, 0, 0, 0, { top: TILE.PLATE2 }),
    box(0.34, 0.16, 0.3, 0.55, -0.02, 0, 0, 1, 0, 0, 1),
    box(0.5, 0.12, 0.16, -0.6, 0.05, 0, 1, 0.8),
    box(2.1, 0.07, 0.13, 0, 0.12, 0, 1, 0.7, 0, 0, 0, Math.PI / 4),
    box(2.1, 0.07, 0.13, 0, 0.12, 0, 1, 0.7, 0, 0, 0, -Math.PI / 4),
    // 旋翼 ×4
    rotor(0.74, 0.74),
    rotor(0.74, -0.74),
    rotor(-0.74, 0.74),
    rotor(-0.74, -0.74),
  ];
  if (hi) {
    // 电机罩 + 桨叶 ×4
    for (const [x, z] of [
      [0.74, 0.74],
      [0.74, -0.74],
      [-0.74, 0.74],
      [-0.74, -0.74],
    ]) {
      parts.push(cyl(0.07, 0.12, 6, x, 0.24, z, 0, 0.5));
      parts.push(box(0.9, 0.02, 0.1, x, 0.21, z, 0, 0.55, 0, 0, 0, x * z > 0 ? 0.6 : -0.6));
    }
    // 腹部挂架 ×2
    for (const side of [1, -1]) parts.push(box(0.7, 0.05, 0.07, 0.05, -0.24, 0.22 * side, 1, 0.6));
    // 尾灯(extra=0.8)/ 腹部弹舱 / 弹体 / 弹头(extra=0.5)/ 天线
    parts.push(box(0.08, 0.06, 0.1, -0.82, 0.08, 0, 0, 1, 0, 0, 0.8));
    parts.push(box(0.4, 0.08, 0.4, 0, -0.2, 0, 0, 0.45));
    parts.push(cyl(0.1, 0.1, 8, 0.42, -0.16, 0, 0, 0.5));
    parts.push(box(0.16, 0.1, 0.12, 0.42, -0.24, 0, 0, 1, 0, 0, 0.5));
    parts.push(box(0.03, 0.3, 0.03, -0.35, 0.3, 0.12, 0, 0.5));
    // 起落橇 ×2
    for (const side of [1, -1]) parts.push(cyl(0.05, 0.5, 5, 0.05, -0.3, 0.14 * side, 0, 0.65, 0, Math.PI / 2));
    // 翼尖航灯 ×2(extra=0.7)
    for (const side of [1, -1]) parts.push(box(0.07, 0.05, 0.07, 0.74 * side, 0.16, 0.74 * side, 0, 1, 0, 0, 0.7));
  }
  const geom = mergeGeometries(parts, false);
  geom.computeVertexNormals();
  return geom;
}

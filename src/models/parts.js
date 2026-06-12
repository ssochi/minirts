// 模型部件工具:为 BoxGeometry/CylinderGeometry 写入图集瓦片属性(aTile)、
// 部件颜色通道(color: r=部件ID g=明暗 b=附加)与动画通道(aAnim: 3=履带滚动 1=负重轮自转 2=旋翼)。
// box()/cyl()/gunBarrel() 是各兵种几何工厂的唯一积木,参数顺序与默认值与原码逐字一致。
import { BoxGeometry, CylinderGeometry, BufferAttribute } from 'three';
import { TILE, isFixedUv, tileRectUv, texelScale } from '../render/atlas/tiles.js';

// 把一组顶点的 uv 缩放到瓦片内,并写入瓦片矩形 aTile(固定 UV 瓦片不随尺寸平铺)
export function applyTileUv(uvAttr, tileArr, indices, tile, du, dv) {
  const [u0, v0, uw, vh] = tileRectUv(tile);
  const scale = texelScale(tile);
  const su = isFixedUv(tile) ? 0.998 : Math.max(du / scale, 0.05);
  const sv = isFixedUv(tile) ? 0.998 : Math.max(dv / scale, 0.05);
  for (const i of indices) {
    uvAttr.setXY(i, uvAttr.getX(i) * su, uvAttr.getY(i) * sv);
    tileArr[i * 4] = u0;
    tileArr[i * 4 + 1] = v0;
    tileArr[i * 4 + 2] = uw;
    tileArr[i * 4 + 3] = vh;
  }
}

// 盒体六面贴瓦片: { all, top, bottom, side, end },面序 +x -x +y -y +z -z
export function tileBox(geom, tiles) {
  const uv = geom.getAttribute(`uv`);
  const tileArr = new Float32Array(uv.count * 4);
  const { width, height, depth } = geom.parameters;
  const all = tiles?.all ?? TILE.PLATE;
  const faces = [
    { tile: tiles?.end ?? all, du: depth, dv: height },
    { tile: tiles?.end ?? all, du: depth, dv: height },
    { tile: tiles?.top ?? all, du: width, dv: depth },
    { tile: tiles?.bottom ?? tiles?.top ?? all, du: width, dv: depth },
    { tile: tiles?.side ?? all, du: width, dv: height },
    { tile: tiles?.side ?? all, du: width, dv: height },
  ];
  for (let f = 0; f < 6; f++)
    applyTileUv(uv, tileArr, [f * 4, f * 4 + 1, f * 4 + 2, f * 4 + 3], faces[f].tile, faces[f].du, faces[f].dv);
  geom.setAttribute(`aTile`, new BufferAttribute(tileArr, 4));
  return geom;
}

// 圆柱贴瓦片: 侧面按周长×高平铺,两端盖按直径平铺(groups: 0=侧 1/2=盖)
export function tileCylinder(geom, sideTile, capTile) {
  const uv = geom.getAttribute(`uv`);
  const tileArr = new Float32Array(uv.count * 4);
  const index = geom.index;
  const r = geom.parameters.radiusTop;
  const h = geom.parameters.height;
  const groupTiles = [
    [sideTile, 2 * Math.PI * r, h],
    [capTile, 2 * r, 2 * r],
    [capTile, 2 * r, 2 * r],
  ];
  const seen = new Set();
  geom.groups.forEach((group, gi) => {
    const [tile, du, dv] = groupTiles[gi] ?? groupTiles[0];
    const verts = [];
    for (let i = group.start; i < group.start + group.count; i++) {
      const v = index.getX(i);
      if (!seen.has(v)) {
        seen.add(v);
        verts.push(v);
      }
    }
    applyTileUv(uv, tileArr, verts, tile, du, dv);
  });
  geom.setAttribute(`aTile`, new BufferAttribute(tileArr, 4));
  return geom;
}

// 写顶点 color 通道: r=部件ID g=明暗系数 b=附加值;并保证存在 aAnim 占位
export function paintPart(geom, part, shadeMul, extra = 0) {
  const count = geom.getAttribute(`position`).count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = part;
    colors[i * 3 + 1] = shadeMul;
    colors[i * 3 + 2] = extra;
  }
  geom.setAttribute(`color`, new BufferAttribute(colors, 3));
  geom.getAttribute(`aAnim`) || geom.setAttribute(`aAnim`, new BufferAttribute(new Float32Array(count * 4), 4));
  return geom;
}

// 写 aAnim vec4: (mode, a, b, c)。mode: 3=履带滚动 1=负重轮自转 2=旋翼
export function setAnim(geom, mode, a, b, c) {
  const count = geom.getAttribute(`position`).count;
  const anim = geom.getAttribute(`aAnim`).array;
  for (let i = 0; i < count; i++) {
    anim[i * 4] = mode;
    anim[i * 4 + 1] = a;
    anim[i * 4 + 2] = b;
    anim[i * 4 + 3] = c;
  }
  return geom;
}

// 盒体积木。旋转顺序: rz → rx → ry,再平移
export function box(w, h, d, x, y, z, part, shade = 1, rz = 0, rx = 0, extra = 0, ry = 0, tiles) {
  const geom = tileBox(new BoxGeometry(w, h, d), tiles);
  rz && geom.rotateZ(rz);
  rx && geom.rotateX(rx);
  ry && geom.rotateY(ry);
  return paintPart(geom.translate(x, y, z), part, shade, extra);
}

// 炮管: 六棱柱,转为沿 +x 方向,贴 BARREL/DARK 瓦片
export function gunBarrel(radius, len, x, y, part, shade) {
  return paintPart(
    tileCylinder(new CylinderGeometry(radius, radius, len, 6), TILE.BARREL, TILE.DARK)
      .rotateZ(-Math.PI / 2)
      .translate(x, y, 0),
    part,
    shade,
  );
}

// 圆柱积木。旋转顺序: rx → rz,再平移
export function cyl(radius, h, segs, x, y, z, part, shade, rx = 0, rz = 0, extra = 0, sideTile = TILE.PLATE, capTile = TILE.PLATE) {
  const geom = tileCylinder(new CylinderGeometry(radius, radius, h, segs), sideTile, capTile);
  rx && geom.rotateX(rx);
  rz && geom.rotateZ(rz);
  return paintPart(geom.translate(x, y, z), part, shade, extra);
}

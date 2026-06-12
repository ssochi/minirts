// 装甲图集瓦片表与 UV 工具(纯数据/纯函数,无依赖)。
// 图集固定 512×512,按 64px 网格(CELL)划分,每块瓦片四周内缩 4px 出血(PAD)防 mipmap 串色。
// TILE 各项为 [格X, 格Y, 格宽, 格高];FIXED_UV_TILES 按数组引用判定(Set 存的是 TILE.X 引用)。

// 原 Q:瓦片矩形表(单位:格)
export const TILE = {
  PLATE: [0, 0, 1, 1],
  PLATE2: [1, 0, 1, 1],
  SIDE: [2, 0, 2, 1],
  ENGINE: [4, 0, 2, 1],
  GRILLE: [6, 0, 1, 1],
  HATCH: [7, 0, 1, 1],
  TURRET: [0, 1, 2, 2],
  TREAD: [2, 1, 2, 1],
  WHEEL: [4, 1, 1, 1],
  BARREL: [5, 1, 1, 1],
  DARK: [6, 1, 1, 1],
  GLASS: [7, 1, 1, 1],
  FAN: [2, 2, 2, 2],
  HAZARD: [4, 2, 1, 1],
  GRID: [5, 2, 1, 1],
  EXHAUST: [6, 2, 1, 1],
  CRATE: [7, 2, 1, 1],
  INTAKE: [0, 3, 1, 1],
  VENTS: [1, 3, 1, 1],
};

// 原 ug:格 → 像素
export const CELL = 64;
// 原 dg:出血内边距(像素)
export const PAD = 4;

// 原 cg:UV 不随面尺寸重复、整块贴满的瓦片集合(按引用判定)
export const FIXED_UV_TILES = new Set([
  TILE.GRILLE,
  TILE.HATCH,
  TILE.TURRET,
  TILE.WHEEL,
  TILE.GLASS,
  TILE.FAN,
  TILE.EXHAUST,
  TILE.CRATE,
  TILE.INTAKE,
  TILE.VENTS,
]);

// 原 lg
export const isFixedUv = (tile) => FIXED_UV_TILES.has(tile);

// 原 ag:瓦片 → 像素矩形 [x, y, w, h](已含出血内缩)
export function tileRectPx(tile) {
  return [tile[0] * CELL + PAD, tile[1] * CELL + PAD, tile[2] * CELL - 2 * PAD, tile[3] * CELL - 2 * PAD];
}

// 原 og:瓦片 → 归一化 UV 矩形 [u, v, w, h](除以图集尺寸 512)
export function tileRectUv(tile) {
  const [x, y, w, h] = tileRectPx(tile);
  return [x / 512, y / 512, w / 512, h / 512];
}

// 原 ig:瓦片纹素密度系数(决定贴图在面上的重复缩放)
export function texelScale(tile) {
  return tile === TILE.TREAD
    ? 1.5
    : tile === TILE.BARREL
      ? 1.1
      : tile === TILE.DARK || tile === TILE.GRID || tile === TILE.HAZARD
        ? 1.2
        : 1.9;
}

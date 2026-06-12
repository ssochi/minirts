// 障碍地图生成 —— 用独立种子(seed ^ 24301)随机摆放岩石与残墙,
// 栅格化为 GRID_W×GRID_H 的占据位图(blocked),并强制清空两侧出生区走廊。
// 主线程与模拟 Worker 各自用同一种子重建,结果必须逐位一致。
import { CONFIG } from '../core/config.js';
import { makeRng } from '../core/rng.js';

export const GRID_W = Math.ceil(CONFIG.mapW / CONFIG.gridCell);
export const GRID_H = Math.ceil(CONFIG.mapH / CONFIG.gridCell);
export const SPAWN_MARGIN = 360; // 地图左右两端出生区宽度,米

export function generateObstacles(seed) {
  const rng = makeRng(seed ^ 24301);
  const blocked = new Uint8Array(GRID_W * GRID_H);
  const shapes = { rocks: [], walls: [] };
  const maxX = CONFIG.mapW - SPAWN_MARGIN - 40;
  // 26 块圆形岩石(避开两侧出生区)
  for (let i = 0; i < 26; i++)
    shapes.rocks.push({
      x: rng.range(400, maxX),
      z: rng.range(60, CONFIG.mapH - 60),
      r: rng.range(8, 22),
    });
  // 8 段薄墙,随机横纵向(厚度固定 7)
  for (let i = 0; i < 8; i++) {
    const horizontal = rng.float() < 0.5;
    shapes.walls.push({
      x: rng.range(400, maxX),
      z: rng.range(80, CONFIG.mapH - 80),
      w: horizontal ? rng.range(50, 110) : 7,
      h: horizontal ? 7 : rng.range(50, 110),
    });
  }
  // 栅格化:格心落入岩石圆/墙体矩形即标记为阻挡
  for (let gy = 0; gy < GRID_H; gy++)
    for (let gx = 0; gx < GRID_W; gx++) {
      const cx = (gx + 0.5) * CONFIG.gridCell;
      const cz = (gy + 0.5) * CONFIG.gridCell;
      let hit = 0;
      for (const rock of shapes.rocks) {
        const dx = cx - rock.x;
        const dz = cz - rock.z;
        if (dx * dx + dz * dz < rock.r * rock.r) {
          hit = 1;
          break;
        }
      }
      if (!hit) {
        for (const wall of shapes.walls)
          if (Math.abs(cx - wall.x) < wall.w / 2 && Math.abs(cz - wall.z) < wall.h / 2) {
            hit = 1;
            break;
          }
      }
      blocked[gy * GRID_W + gx] = hit;
    }
  // 地图四边封死;左右出生区走廊强制清空
  const marginCells = Math.floor(SPAWN_MARGIN / CONFIG.gridCell);
  for (let gy = 0; gy < GRID_H; gy++)
    for (let gx = 0; gx < GRID_W; gx++) {
      if (gx === 0 || gy === 0 || gx === GRID_W - 1 || gy === GRID_H - 1) {
        blocked[gy * GRID_W + gx] = 1;
        continue;
      }
      if (gx < marginCells || gx >= GRID_W - marginCells) blocked[gy * GRID_W + gx] = 0;
    }
  return { blocked, shapes };
}

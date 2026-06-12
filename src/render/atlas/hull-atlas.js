// 512×512 手绘装甲图集(程序化像素画):坦克装甲板/侧裙/引擎盖/炮塔顶/履带/负重轮等全部贴图。
// 分两遍绘制:第一遍铺底色+结构,第二遍对部分瓦片叠加细节;每块画完都做 gutter 出血防 mipmap 串色。
// getHullAtlas() 模块级单例缓存(原 fg),首次调用后复用同一张 DataTexture。
import { TILE, PAD, tileRectPx } from './tiles.js';
import { shade, PixelPainter } from './painter.js';

let cachedAtlas = null; // 原 fg

// 原 sg
export function getHullAtlas() {
  if (cachedAtlas) return cachedAtlas;
  const p = new PixelPainter(512),
    base = [196, 192, 184],
    dark = [86, 84, 80],
    light = [242, 238, 228],
    rust = [118, 92, 64],
    grime = [70, 66, 58];
  p.rect(0, 0, 512, 512, base);
  // 风化做旧:随机划痕 + 锈斑/油渍圆点 + 明暗抖动(独立 LCG,seed 决定图案)
  const weather = (x, y, w, h, seed) => {
      let s = seed * 2654435761 + 1;
      const rnd = () => (s = (s * 1103515245 + 12345) & 2147483647) / 2147483647;
      for (let i = 0; i < Math.round((w * h) / 140); i++) {
        let sx = x + rnd() * w,
          sy = y + rnd() * h;
        const ang = rnd() * Math.PI,
          len = 3 + rnd() * 7,
          mul = rnd() < 0.5 ? 0.8 : 1.12;
        for (let k = 0; k < len; k++) {
          p.px(sx | 0, sy | 0, shade(base, mul));
          sx += Math.cos(ang);
          sy += Math.sin(ang) * 0.4;
        }
      }
      for (let i = 0; i < Math.round((w * h) / 260); i++) {
        const cx = x + rnd() * w,
          cy = y + rnd() * h,
          rad = 1 + rnd() * 2.5,
          col = rnd() < 0.5 ? rust : grime;
        for (let dy = -rad; dy <= rad; dy++)
          for (let dx = -rad; dx <= rad; dx++)
            dx * dx + dy * dy <= rad * rad && rnd() < 0.7 && p.px(cx + dx, cy + dy, shade(col, 0.9 + rnd() * 0.3));
      }
      p.dither(x, y, w, h, shade(base, 0.9), 0.06);
      p.dither(x, y, w, h, shade(base, 1.06), 0.05);
    },
    // 螺栓:2×2 亮块 + 右下三粒暗影
    bolt = (x, y) => {
      p.rect(x, y, 2, 2, light);
      p.px(x + 2, y + 1, dark);
      p.px(x + 1, y + 2, dark);
      p.px(x + 2, y + 2, dark);
    },
    // 装甲面板:底色 + 顶部高光带 + 底部阴影带 + 左亮右暗边线
    armorPanel = (x, y, w, h, c) => {
      p.rect(x, y, w, h, c);
      p.rect(x + 1, y + 1, w - 2, 2, shade(c, 1, 38));
      p.rect(x + 1, y + h - 3, w - 2, 2, shade(c, 0.64));
      for (let k = 1; k < h - 1; k++) {
        p.px(x + 1, y + k, shade(c, 1, 22));
        p.px(x + w - 2, y + k, shade(c, 0.72));
      }
    },
    // 原 l:按瓦片矩形做 PAD 宽出血
    bleed = (tile) => {
      const [x, y, w, h] = tileRectPx(tile);
      p.gutter(x, y, w, h, PAD);
    };
  {
    // PLATE:四分格装甲板 + 十字暗缝 + 十颗螺栓
    const [x, y, w, h] = tileRectPx(TILE.PLATE),
      halfW = Math.round(w / 2),
      halfH = Math.round(h / 2);
    armorPanel(x, y, halfW, halfH, base);
    armorPanel(x + halfW, y, w - halfW, halfH, shade(base, 0.94));
    armorPanel(x, y + halfH, halfW, h - halfH, shade(base, 0.96));
    armorPanel(x + halfW, y + halfH, w - halfW, h - halfH, base);
    p.rect(x, y + halfH - 1, w, 2, dark);
    p.rect(x + halfW - 1, y, 2, h, dark);
    for (const [bx, by] of [
      [4, 4],
      [halfW - 7, 4],
      [halfW + 5, 4],
      [w - 7, 4],
      [4, halfH - 7],
      [w - 7, halfH - 7],
      [4, h - 7],
      [halfW - 7, h - 7],
      [halfW + 5, h - 7],
      [w - 7, h - 7],
    ])
      bolt(x + bx, y + by);
    weather(x + 2, y + 2, w - 4, h - 4, 11);
    bleed(TILE.PLATE);
  }
  {
    // PLATE2:上下两段装甲板 + 圆形检修盖 + 一排螺栓 + 顶缘点线
    const [x, y, w, h] = tileRectPx(TILE.PLATE2),
      split = Math.round(h * 0.6);
    armorPanel(x, y, w, split, base);
    armorPanel(x, y + split, w, h - split, shade(base, 0.93));
    p.rect(x, y + split - 1, w, 2, dark);
    const cx = x + w * 0.3,
      cy = y + h * 0.32;
    for (let dy = -7; dy <= 7; dy++)
      for (let dx = -7; dx <= 7; dx++) {
        const d = Math.hypot(dx, dy);
        d <= 7 && p.px(cx + dx, cy + dy, d > 5.4 ? dark : shade(base, 0.9));
      }
    for (let bx = 6; bx < w - 5; bx += 8) bolt(x + bx, y + split + 4);
    bolt(x + w - 9, y + 5);
    bolt(x + w - 16, y + 5);
    for (let k = 4; k < w - 4; k += 3) p.px(x + k, y + 3, shade(base, 1, 26));
    weather(x + 2, y + 2, w - 4, h - 4, 23);
    bleed(TILE.PLATE2);
  }
  {
    // SIDE:侧裙板,三道竖向接缝 + 螺栓列 + 底部四道流挂污渍
    const [x, y, w, h] = tileRectPx(TILE.SIDE);
    armorPanel(x, y, w, h, base);
    for (const frac of [0.25, 0.5, 0.75]) {
      const sx = Math.round(w * frac);
      p.rect(x + sx, y + 1, 2, h - 2, dark);
      for (let k = 1; k < h - 1; k++) p.px(x + sx + 2, y + k, shade(base, 1, 28));
      for (let by = 5; by < h - 5; by += 9) {
        bolt(x + sx - 5, y + by);
        bolt(x + sx + 5, y + by);
      }
    }
    for (let bx = 6; bx < w - 6; bx += 9) bolt(x + bx, y + 3);
    for (const frac of [0.12, 0.38, 0.62, 0.9])
      for (let k = 0; k < 12; k++) p.px(x + w * frac, y + h - 3 - k, shade(grime, 1 + k * 0.04));
    weather(x + 2, y + 2, w - 4, h - 4, 37);
    bleed(TILE.SIDE);
  }
  {
    // ENGINE:引擎盖,两组百叶散热窗 + 中央加强筋 + 上下螺栓
    const [x, y, w, h] = tileRectPx(TILE.ENGINE);
    armorPanel(x, y, w, h, base);
    const vent = (vx, vw) => {
      p.rect(vx - 1, y + 5, vw + 2, h - 10, shade(base, 0.5));
      for (let k = 0; k < 6; k++) {
        const ly = y + 6 + Math.round((k * (h - 13)) / 6);
        p.rect(vx, ly, vw, 2, [52, 50, 46]);
        p.rect(vx, ly + 2, vw, 1, shade(base, 1, 26));
      }
    };
    vent(x + 5, Math.round(w * 0.34));
    vent(x + Math.round(w * 0.56), Math.round(w * 0.34));
    p.rect(x + Math.round(w * 0.47), y + 3, 3, h - 6, shade(base, 1, 18));
    bolt(x + Math.round(w * 0.47), y + 4);
    bolt(x + Math.round(w * 0.47), y + h - 8);
    weather(x + 2, y + 2, w - 4, h - 4, 53);
    bleed(TILE.ENGINE);
  }
  {
    // GRILLE:散热格栅,六条竖向栅条 + 内框
    const [x, y, w, h] = tileRectPx(TILE.GRILLE);
    armorPanel(x, y, w, h, base);
    for (let k = 0; k < 6; k++) {
      const gx = x + 7 + k * 7;
      p.rect(gx, y + 7, 3, h - 14, [52, 50, 46]);
      p.rect(gx + 3, y + 7, 1, h - 14, shade(base, 1, 26));
    }
    p.frame(x + 4, y + 4, w - 8, h - 8, shade(base, 0.7));
    weather(x + 2, y + 2, w - 4, h - 4, 67);
    bleed(TILE.GRILLE);
  }
  {
    // HATCH:圆形舱盖 + 八颗周圈亮点 + 横向把手
    const [x, y, w, h] = tileRectPx(TILE.HATCH);
    armorPanel(x, y, w, h, base);
    const cx = x + w / 2,
      cy = y + h / 2,
      rad = w * 0.36;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > rad) continue;
        const col =
          d > rad - 2.4 ? dark : d > rad - 4 ? shade(base, 1, 28) : dy < -2 ? shade(base, 1, 14) : shade(base, 0.88);
        p.px(cx + dx, cy + dy, col);
      }
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      p.px(cx + Math.cos(ang) * (rad - 1), cy + Math.sin(ang) * (rad - 1), light);
    }
    p.rect(cx - 7, cy - 1, 14, 3, shade(base, 0.55));
    p.rect(cx - 7, cy - 1, 14, 1, light);
    weather(x + 2, y + 2, w - 4, h - 4, 71);
    bleed(TILE.HATCH);
  }
  {
    // TURRET:炮塔顶,焊缝线 + 指挥塔圆舱 + 小面板 + 防滑钉阵 + 潜望镜框
    const [x, y, w, h] = tileRectPx(TILE.TURRET);
    armorPanel(x, y, w, h, base);
    p.rect(x + 2, y + Math.round(h / 2) - 1, w - 4, 2, dark);
    p.rect(x + Math.round(w / 2) + 10, y + 2, 2, Math.round(h / 2) - 2, dark);
    p.rect(x + Math.round(w / 4), y + Math.round(h / 2), 2, Math.round(h / 2) - 2, dark);
    for (let bx = 8; bx < w - 8; bx += 11) {
      bolt(x + bx, y + Math.round(h / 2) - 5);
      bolt(x + bx, y + Math.round(h / 2) + 4);
    }
    const cx = x + w * 0.3,
      cy = y + h * 0.26;
    for (let dy = -17; dy <= 17; dy++)
      for (let dx = -17; dx <= 17; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 17) continue;
        const col =
          d > 14.4 ? dark : d > 12.4 ? shade(base, 1, 28) : dy < -3 ? shade(base, 1, 14) : shade(base, 0.88);
        p.px(cx + dx, cy + dy, col);
      }
    for (let k = 0; k < 10; k++) {
      const ang = (k / 10) * Math.PI * 2;
      p.px(cx + Math.cos(ang) * 15, cy + Math.sin(ang) * 15, light);
    }
    p.rect(cx - 8, cy - 1, 16, 3, shade(base, 0.55));
    armorPanel(x + Math.round(w * 0.6), y + 10, 26, 21, shade(base, 1.03));
    p.frame(x + Math.round(w * 0.6) - 1, y + 9, 28, 23, dark);
    bolt(x + Math.round(w * 0.6) + 2, y + 12);
    bolt(x + Math.round(w * 0.6) + 21, y + 12);
    for (let dy = 0; dy < 30; dy += 4)
      for (let dx = 0; dx < 42; dx += 4) {
        p.rect(x + 9 + dx, y + Math.round(h * 0.6) + dy, 2, 2, shade(base, 0.6));
        p.px(x + 9 + dx, y + Math.round(h * 0.6) + dy, shade(base, 1, 16));
      }
    p.frame(x + 6, y + Math.round(h * 0.6) - 3, 50, 38, shade(base, 0.66));
    for (const frac of [0.84, 0.92]) {
      p.frame(x + w * frac, y + h * 0.68, 6, 9, shade(base, 0.5));
      p.px(x + w * frac + 1, y + h * 0.68 + 1, light);
    }
    weather(x + 3, y + 3, w - 6, h - 6, 83);
    bleed(TILE.TURRET);
  }
  {
    // TREAD:履带,14 节链板(亮板+暗缝+中心销)+ 上亮下暗边 + 底部锈渍
    const [x, y, w, h] = tileRectPx(TILE.TREAD);
    p.rect(x, y, w, h, [96, 92, 86]);
    for (let k = 0; k < 14; k++) {
      const sx = x + Math.round((k * w) / 14);
      p.rect(sx, y + 2, 3, h - 4, [198, 192, 182]);
      p.rect(sx + 3, y + 2, 2, h - 4, [58, 56, 52]);
      p.px(sx + 1, y + Math.round(h / 2), [44, 42, 40]);
    }
    p.rect(x, y, w, 2, [150, 146, 138]);
    p.rect(x, y + h - 2, w, 2, [50, 48, 44]);
    p.dither(x, y + h - 8, w, 7, rust, 0.07);
    bleed(TILE.TREAD);
  }
  {
    // WHEEL:负重轮,同心圆轮辋/胎面/轮毂 + 八组螺栓与减重孔
    const [x, y, w, h] = tileRectPx(TILE.WHEEL);
    p.rect(x, y, w, h, [98, 94, 88]);
    const cx = x + w / 2,
      cy = y + h / 2,
      rad = w / 2 - 1;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > rad) continue;
        const col =
          d > rad * 0.84
            ? [64, 62, 58]
            : d > rad * 0.72
              ? [110, 106, 100]
              : d < rad * 0.24
                ? [205, 200, 190]
                : [140, 136, 128];
        p.px(cx + dx, cy + dy, col);
      }
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      p.rect(cx + Math.cos(ang) * rad * 0.46 - 1, cy + Math.sin(ang) * rad * 0.46 - 1, 2, 2, [228, 224, 214]);
      const hx = cx + Math.cos(ang + 0.39) * rad * 0.55,
        hy = cy + Math.sin(ang + 0.39) * rad * 0.55;
      p.rect(hx - 1, hy - 1, 3, 3, [86, 82, 78]);
    }
    bleed(TILE.WHEEL);
  }
  {
    // BARREL:炮管,纵向正弦明暗(圆柱光感)+ 三道箍环 + 轻微抖动
    const [x, y, w, h] = tileRectPx(TILE.BARREL);
    for (let row = 0; row < h; row++) {
      const lum = 0.66 + 0.5 * Math.sin((row / h) * Math.PI);
      p.rect(x, y + row, w, 1, shade(base, lum));
    }
    for (const frac of [0.18, 0.42, 0.72]) {
      const sx = x + Math.round(w * frac);
      p.rect(sx, y, 3, h, [58, 56, 52]);
      p.rect(sx + 3, y, 1, h, shade(base, 1, 30));
    }
    p.dither(x, y, w, h, shade(base, 0.84), 0.05);
    bleed(TILE.BARREL);
  }
  {
    // DARK:深色底材(履带底盘等),双层抖动 + 六道横纹
    const [x, y, w, h] = tileRectPx(TILE.DARK);
    p.rect(x, y, w, h, [108, 104, 98]);
    p.dither(x, y, w, h, [84, 80, 76], 0.3);
    p.dither(x, y, w, h, [132, 126, 118], 0.12);
    for (let k = 0; k < 6; k++) p.rect(x, y + Math.round((k * h) / 6), w, 1, [90, 86, 80]);
    bleed(TILE.DARK);
  }
  {
    // GLASS:观察窗玻璃,斜向高光条 + 三层窗框
    const [x, y, w, h] = tileRectPx(TILE.GLASS);
    p.rect(x, y, w, h, [52, 78, 96]);
    for (let k = 0; k < 22; k++) {
      p.px(x + 8 + k, y + h - 12 - k * 0.7, [200, 228, 238]);
      p.px(x + 9 + k, y + h - 12 - k * 0.7, [140, 180, 196]);
    }
    for (let k = 0; k < 10; k++) p.px(x + w - 16 + k, y + h - 8 - k, [120, 160, 178]);
    p.frame(x, y, w, h, [40, 38, 36]);
    p.frame(x + 1, y + 1, w - 2, h - 2, [168, 162, 152]);
    p.frame(x + 2, y + 2, w - 4, h - 4, [30, 44, 56]);
    bleed(TILE.GLASS);
  }
  {
    // FAN:风扇,双叶旋涡明暗 + 中心轴帽 + 外圈暗环
    const [x, y, w, h] = tileRectPx(TILE.FAN),
      cx = x + w / 2,
      cy = y + h / 2,
      rad = w / 2 - 1;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > rad) continue;
        const blade = Math.max(0, Math.sin(Math.atan2(dy, dx) * 2 + d * 0.16));
        let lum = 0.34 + 0.52 * blade * blade;
        d < 7 ? (lum = 0.95) : d < 10 && (lum = 0.4);
        d > rad - 2 && (lum = 0.3);
        p.px(cx + dx, cy + dy, shade(base, lum));
      }
    bleed(TILE.FAN);
  }
  {
    // HAZARD:黄黑警示斜纹 + 做旧抖动
    const [x, y, w, h] = tileRectPx(TILE.HAZARD);
    for (let row = 0; row < h; row++)
      for (let col = 0; col < w; col++)
        p.px(x + col, y + row, (((col + row) / 8) | 0) % 2 === 0 ? [206, 168, 60] : [50, 48, 44]);
    p.dither(x, y, w, h, shade(base, 0.6), 0.07);
    bleed(TILE.HAZARD);
  }
  {
    // GRID:防滑格纹板,6px 间距凸点阵
    const [x, y, w, h] = tileRectPx(TILE.GRID);
    armorPanel(x, y, w, h, base);
    for (let gy = 5; gy < h - 4; gy += 6)
      for (let gx = 5; gx < w - 4; gx += 6) {
        p.rect(x + gx, y + gy, 3, 3, shade(base, 0.56));
        p.px(x + gx, y + gy, shade(base, 1, 20));
      }
    weather(x + 2, y + 2, w - 4, h - 4, 97);
    bleed(TILE.GRID);
  }
  {
    // PLATE 细节二遍:十字缝旁点焊痕 + 小检修槽 + 三个高光角点
    const [x, y, w, h] = tileRectPx(TILE.PLATE),
      halfW = Math.round(w / 2),
      halfH = Math.round(h / 2);
    for (let k = 3; k < w - 3; k += 3) p.px(x + k, y + halfH + 2, shade(base, 1, 30));
    for (let k = 3; k < h - 3; k += 3) p.px(x + halfW + 2, y + k, shade(base, 1, 30));
    p.rect(x + 8, y + halfH + 8, 10, 4, shade(base, 0.6));
    p.frame(x + 8, y + halfH + 8, 10, 4, dark);
    for (const [dx, dy] of [
      [2, 2],
      [w - 3, 2],
      [2, h - 3],
    ])
      p.px(x + dx, y + dy, light);
    p.gutter(x, y, w, h, PAD);
  }
  {
    // SIDE 细节二遍:两道挂胶条(带亮卡扣)+ 底部双层锈渍抖动
    const [x, y, w, h] = tileRectPx(TILE.SIDE);
    for (const frac of [0.18, 0.82]) {
      const sx = x + Math.round(w * frac);
      p.rect(sx, y + 2, 3, h - 4, shade(grime, 0.9));
      p.rect(sx, y + Math.round(h / 2) - 2, 3, 4, light);
    }
    p.dither(x + 1, y + h - 10, w - 2, 5, rust, 0.13);
    p.dither(x + 1, y + h - 5, w - 2, 4, shade(rust, 0.8), 0.3);
    p.gutter(x, y, w, h, PAD);
  }
  {
    // ENGINE 细节二遍:油箱盖圆 + 顶部锈渍抖动
    const [x, y, w, h] = tileRectPx(TILE.ENGINE),
      cx = x + Math.round(w * 0.49),
      cy = y + h - 9;
    for (let dy = -5; dy <= 5; dy++)
      for (let dx = -5; dx <= 5; dx++) {
        const d = Math.hypot(dx, dy);
        d <= 5 && p.px(cx + dx, cy + dy, d > 3.6 ? dark : shade(base, 0.82));
      }
    p.rect(cx - 2, cy - 1, 5, 2, shade(base, 0.6));
    p.dither(x + 3, y + 3, w - 6, 4, rust, 0.12);
    p.gutter(x, y, w, h, PAD);
  }
  {
    // TURRET 细节二遍:指挥塔外亮环 + 三块观察镜 + 面板缝点线 + 右上三道天线座
    const [x, y, w, h] = tileRectPx(TILE.TURRET),
      cx = x + w * 0.3,
      cy = y + h * 0.26;
    for (let k = 0; k < 26; k++) {
      const ang = (k / 26) * Math.PI * 2;
      p.px(cx + Math.cos(ang) * 20, cy + Math.sin(ang) * 20, shade(base, 1, 20));
    }
    for (const [fx, fy] of [
      [0.13, 0.13],
      [0.47, 0.1],
      [0.3, 0.45],
    ]) {
      p.rect(x + w * fx, y + h * fy, 7, 5, [58, 56, 52]);
      p.rect(x + w * fx + 1, y + h * fy + 1, 5, 1, [120, 140, 150]);
    }
    const bx = x + Math.round(w * 0.6) - 1,
      by = y + 9;
    for (let k = 0; k < 28; k += 3) {
      p.px(bx + k, by - 2, shade(base, 1, 26));
      p.px(bx + k, by + 24, shade(base, 1, 26));
    }
    for (let k = 0; k < 3; k++) p.rect(x + w - 14 + k * 4, y + 6, 2, 7, [225, 220, 205]);
    p.gutter(x, y, w, h, PAD);
  }
  {
    // TREAD 细节二遍:每节中部亮竖条 + 上下导齿亮点
    const [x, y, w, h] = tileRectPx(TILE.TREAD);
    for (let k = 0; k < 14; k++) {
      const sx = x + Math.round((k * w) / 14);
      p.rect(sx + 1, y + Math.round(h / 2) - 2, 1, 4, [225, 220, 210]);
      p.px(sx + 4, y + 4, [160, 156, 148]);
      p.px(sx + 4, y + h - 5, [160, 156, 148]);
    }
    p.gutter(x, y, w, h, PAD);
  }
  {
    // WHEEL 细节二遍:内圈点环 + 上弧锈迹
    const [x, y, w, h] = tileRectPx(TILE.WHEEL),
      cx = x + w / 2,
      cy = y + h / 2,
      rad = w / 2 - 1;
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2;
      p.px(cx + Math.cos(ang) * rad * 0.78, cy + Math.sin(ang) * rad * 0.78, [86, 84, 80]);
    }
    for (let k = 0; k < 16; k++) {
      const ang = Math.PI * (0.15 + (k / 16) * 0.7);
      p.px(cx + Math.cos(ang) * rad * 0.9, cy + Math.sin(ang) * rad * 0.9, shade(rust, 0.9));
    }
    p.gutter(x, y, w, h, PAD);
  }
  {
    // BARREL 细节二遍:炮口端棋盘格制退器 + 三道刻度点线
    const [x, y, w, h] = tileRectPx(TILE.BARREL);
    for (let row = 0; row < h; row++)
      for (let k = 0; k < 6; k++) (k + row) % 2 === 0 && p.px(x + w - 6 + k, y + row, [70, 66, 60]);
    for (const frac of [0.3, 0.55, 0.8])
      for (let k = 2; k < w - 8; k += 2) p.px(x + k, y + Math.round(h * frac), shade(base, 1, 22));
    p.gutter(x, y, w, h, PAD);
  }
  {
    // GLASS 细节二遍:四角固定垫片
    const [x, y, w, h] = tileRectPx(TILE.GLASS);
    for (const [dx, dy] of [
      [3, 3],
      [w - 5, 3],
      [3, h - 5],
      [w - 5, h - 5],
    ])
      p.rect(x + dx, y + dy, 2, 2, [210, 206, 196]);
    p.gutter(x, y, w, h, PAD);
  }
  {
    // EXHAUST:排气格栅,五道横向开槽 + 烟熏抖动
    const [x, y, w, h] = tileRectPx(TILE.EXHAUST);
    armorPanel(x, y, w, h, shade(base, 0.85));
    for (let k = 0; k < 5; k++) {
      const ly = y + 6 + k * 9;
      p.rect(x + 5, ly, w - 10, 3, [50, 48, 44]);
      p.rect(x + 5, ly + 3, w - 10, 2, shade(base, 1, 18));
    }
    p.dither(x + 3, y + 3, w - 6, h - 6, [60, 56, 50], 0.18);
    bleed(TILE.EXHAUST);
  }
  {
    // CRATE:弹药/储物箱,十字捆扎带 + 中心锁扣 + 四角护板
    const [x, y, w, h] = tileRectPx(TILE.CRATE);
    armorPanel(x, y, w, h, shade(base, 0.96));
    p.rect(x + Math.round(w / 2) - 2, y + 1, 4, h - 2, shade(grime, 1.1));
    p.rect(x + 1, y + Math.round(h / 2) - 2, w - 2, 4, shade(grime, 1.1));
    p.rect(x + Math.round(w / 2) - 3, y + Math.round(h / 2) - 3, 6, 6, [196, 188, 168]);
    p.frame(x + Math.round(w / 2) - 3, y + Math.round(h / 2) - 3, 6, 6, dark);
    for (const [dx, dy] of [
      [1, 1],
      [w - 7, 1],
      [1, h - 7],
      [w - 7, h - 7],
    ]) {
      p.rect(x + dx, y + dy, 6, 6, shade(base, 0.7));
      p.px(x + dx + 2, y + dy + 2, light);
    }
    weather(x + 2, y + 2, w - 4, h - 4, 131);
    bleed(TILE.CRATE);
  }
  {
    // INTAKE:进气口,三叶旋涡叶片圆盘 + 竖向防护栅条
    const [x, y, w, h] = tileRectPx(TILE.INTAKE);
    armorPanel(x, y, w, h, base);
    const cx = x + w / 2,
      cy = y + h / 2,
      rad = w * 0.38;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > rad) continue;
        let col = shade(base, 0.3 + 0.25 * Math.max(0, Math.sin(Math.atan2(dy, dx) * 3 + d * 0.3)));
        d > rad - 1.8 && (col = dark);
        p.px(cx + dx, cy + dy, col);
      }
    for (let dx = -rad; dx <= rad; dx += 4)
      for (let dy = -rad; dy <= rad; dy++) Math.hypot(dx, dy) < rad - 1 && p.px(cx + dx, cy + dy, shade(base, 0.74));
    bleed(TILE.INTAKE);
  }
  {
    // VENTS:双列百叶通风窗
    const [x, y, w, h] = tileRectPx(TILE.VENTS);
    armorPanel(x, y, w, h, shade(base, 0.92));
    for (const frac of [0.16, 0.58]) {
      const sx = x + Math.round(w * frac);
      p.rect(sx - 1, y + 5, Math.round(w * 0.27) + 2, h - 10, shade(base, 0.5));
      for (let k = 0; k < 7; k++) {
        const ly = y + 6 + Math.round((k * (h - 13)) / 7);
        p.rect(sx, ly, Math.round(w * 0.27), 2, [54, 52, 48]);
        p.rect(sx, ly + 2, Math.round(w * 0.27), 1, shade(base, 1, 22));
      }
    }
    weather(x + 2, y + 2, w - 4, h - 4, 139);
    bleed(TILE.VENTS);
  }
  cachedAtlas = p.texture();
  return cachedAtlas;
}

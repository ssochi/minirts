// 像素画笔:在 Uint8ClampedArray 像素缓冲上手绘,最终 texture() 输出 three.js DataTexture。
// 自带 LCG 确定性伪随机;提供矩形/描边/倒角/面板/抖动/铆钉/格栅/履带/出血(gutter)等绘制原语。
import { DataTexture, NearestFilter, LinearMipmapLinearFilter, SRGBColorSpace } from 'three';

// 原 Z:颜色乘加,[r,g,b] 各通道 * mul + add
export function shade(c, mul, add = 0) {
  return [c[0] * mul + add, c[1] * mul + add, c[2] * mul + add];
}

// 原 ng
export class PixelPainter {
  size;
  data;
  seed;
  constructor(size = 256, seed = 2654435769) {
    this.size = size;
    this.data = new Uint8ClampedArray(size * size * 4);
    this.seed = seed;
  }
  // LCG 伪随机 [0,1)
  rnd() {
    this.seed = (this.seed * 1103515245 + 12345) & 2147483647;
    return this.seed / 2147483647;
  }
  // 写单像素(越界静默忽略),alpha 恒 255
  px(x, y, c) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y | 0) * this.size * 4 + (x | 0) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = 255;
  }
  // 实心矩形
  rect(x, y, w, h, c) {
    for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) this.px(x + dx, y + dy, c);
  }
  // 空心矩形描边
  frame(x, y, w, h, c) {
    for (let dx = 0; dx < w; dx++) {
      this.px(x + dx, y, c);
      this.px(x + dx, y + h - 1, c);
    }
    for (let dy = 0; dy < h; dy++) {
      this.px(x, y + dy, c);
      this.px(x + w - 1, y + dy, c);
    }
  }
  // 倒角:上/左用亮色,下/右用暗色
  bevel(x, y, w, h, light, dark) {
    for (let dx = 0; dx < w - 1; dx++) this.px(x + dx, y, light);
    for (let dy = 0; dy < h - 1; dy++) this.px(x, y + dy, light);
    for (let dx = 1; dx < w; dx++) this.px(x + dx, y + h - 1, dark);
    for (let dy = 1; dy < h; dy++) this.px(x + w - 1, y + dy, dark);
  }
  // 带倒角的面板(lift 为高光/阴影偏移量)
  panel(x, y, w, h, c, lift = 22) {
    this.rect(x, y, w, h, c);
    this.bevel(x, y, w, h, shade(c, 1, lift), shade(c, 1, -lift));
  }
  // 随机抖动散点(density 为命中概率)
  dither(x, y, w, h, c, density) {
    for (let dy = 0; dy < h; dy++)
      for (let dx = 0; dx < w; dx++) this.rnd() < density && this.px(x + dx, y + dy, c);
  }
  // 铆钉:左上亮点 + 右下暗点
  rivet(x, y, c) {
    this.px(x, y, shade(c, 1, 38));
    this.px(x + 1, y + 1, shade(c, 1, -34));
  }
  // 格栅:count 条横('h')或竖条纹,每条一亮一暗
  grille(x, y, w, h, count, c, dir = 'h') {
    this.rect(x, y, w, h, shade(c, 1, -30));
    for (let i = 0; i < count; i++)
      if (dir === 'h') {
        const ly = y + 1 + Math.round((i * (h - 2)) / count);
        for (let dx = 1; dx < w - 1; dx++) {
          this.px(x + dx, ly, shade(c, 1, 14));
          this.px(x + dx, ly + 1, shade(c, 1, -48));
        }
      } else {
        const lx = x + 1 + Math.round((i * (w - 2)) / count);
        for (let dy = 1; dy < h - 1; dy++) {
          this.px(lx, y + dy, shade(c, 1, 14));
          this.px(lx + 1, y + dy, shade(c, 1, -48));
        }
      }
  }
  // 履带链节:count 节,亮板 + 节间暗缝
  treads(x, y, w, h, count, c) {
    this.rect(x, y, w, h, shade(c, 1, -18));
    for (let i = 0; i < count; i++) {
      const sx = x + Math.round((i * w) / count),
        linkW = Math.max(2, Math.round((w / count) * 0.45));
      this.rect(sx, y + 1, linkW, h - 2, shade(c, 1, 12));
      for (let dy = 1; dy < h - 1; dy++) this.px(sx + linkW, y + dy, shade(c, 1, -42));
    }
  }
  // 出血:把矩形边缘像素向外复制 pad 圈(防 mipmap 取到邻块颜色)
  gutter(x, y, w, h, pad = 4) {
    const sample = (sx, sy) => {
      const i = (sy | 0) * this.size * 4 + (sx | 0) * 4;
      return [this.data[i], this.data[i + 1], this.data[i + 2]];
    };
    for (let o = 1; o <= pad; o++) {
      for (let i = -o; i < w + o; i++) {
        const cx = Math.min(Math.max(x + i, x), x + w - 1);
        this.px(x + i, y - o, sample(cx, y));
        this.px(x + i, y + h - 1 + o, sample(cx, y + h - 1));
      }
      for (let i = 0; i < h; i++) {
        this.px(x - o, y + i, sample(x, y + i));
        this.px(x + w - 1 + o, y + i, sample(x + w - 1, y + i));
      }
    }
  }
  // 输出 DataTexture(最近邻放大 + 三线性 mipmap 缩小,sRGB)
  texture() {
    const tex = new DataTexture(this.data, this.size, this.size);
    tex.magFilter = NearestFilter;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }
}

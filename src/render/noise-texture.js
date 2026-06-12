// 噪声软斑纹理:128×128 CanvasTexture 单例。alpha 通道 = 软圆径向衰减 × 双倍频值噪声破边
// (RGB 恒白),供粒子/曳光片元着色器作 uMap 采样——把硬边方块变成气体感光斑。
// 固定种子 LCG 生成 9×9 值噪声格点,双线性插值采样;首次调用后模块级缓存复用(原 a_)。
import { CanvasTexture, LinearFilter, ClampToEdgeWrapping } from 'three';

// 模块级单例缓存(原 a_,原 11 号模块仅做 a_ = null 初始化)
let cachedTexture = null;

// 0..1 三次平滑(smoothstep,原 i_)
function smooth01(x) {
  const t = Math.min(Math.max(x, 0), 1);
  return t * t * (3 - 2 * t);
}

// 原 r_
export function getNoiseTexture() {
  if (cachedTexture) return cachedTexture;
  // 固定种子 LCG:每次运行生成的纹理逐字节一致
  let state = 2654435769;
  const rand = () => (state = (state * 1103515245 + 12345) & 2147483647) / 2147483647;
  const grid = new Float32Array(81); // 9×9 值噪声格点
  for (let i = 0; i < grid.length; i++) grid[i] = rand();
  // 双线性插值采样(8×8 单元;夹到 7.9999 防右/下边越界)
  const sample = (u, v) => {
    const fx = Math.min(u * 8, 7.9999),
      fy = Math.min(v * 8, 7.9999),
      x0 = fx | 0,
      y0 = fy | 0,
      sx = fx - x0,
      sy = fy - y0,
      v00 = grid[y0 * 9 + x0],
      v10 = grid[y0 * 9 + x0 + 1],
      v01 = grid[(y0 + 1) * 9 + x0],
      v11 = grid[(y0 + 1) * 9 + x0 + 1];
    return v00 + (v10 - v00) * sx + (v01 - v00) * sy + (v00 - v10 - v01 + v11) * sx * sy;
  };
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(128, 128);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const u = (x + 0.5) / 128,
        v = (y + 0.5) / 128,
        dist = Math.hypot(u - 0.5, v - 0.5) * 2; // 0=中心 1=内切圆边缘
      const noise = sample(u, v) * 0.62 + sample((u * 2.3) % 1, (v * 2.3) % 1) * 0.38;
      let alpha = Math.max(1 - dist, 0) ** 1.6 * (0.72 + 0.55 * noise);
      alpha *= 1 - smooth01((dist - 0.78) / 0.22); // 外缘平滑归零:保证贴图边界 alpha=0,越界采样安全
      const at = (y * 128 + x) * 4,
        byte = Math.min(255, alpha * 255) | 0;
      img.data[at] = img.data[at + 1] = img.data[at + 2] = 255;
      img.data[at + 3] = byte;
    }
  ctx.putImageData(img, 0, 0);
  cachedTexture = new CanvasTexture(canvas);
  cachedTexture.minFilter = LinearFilter;
  cachedTexture.magFilter = LinearFilter;
  cachedTexture.wrapS = cachedTexture.wrapT = ClampToEdgeWrapping;
  return cachedTexture;
}

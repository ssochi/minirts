// 地形高度场 —— 三组正弦叠加的解析函数。
// CPU(单位贴地、相机)与 GPU(着色器顶点偏移)各算一遍,
// 两份实现的系数必须严格一致,否则单位会浮空/陷地。

export function terrainHeight(x, z) {
  return (
    5.5 * Math.sin(x * 0.006 + 1.3) * Math.sin(z * 0.0075 + 0.7) +
    2.8 * Math.sin(x * 0.016 + 4.1) * Math.sin(z * 0.013 + 2.4) +
    1.2 * Math.sin(x * 0.034 + 0.9) * Math.sin(z * 0.029 + 3.3)
  );
}

export const TERRAIN_HEIGHT_GLSL = `
  float terrainH(vec2 p) {
    return 5.5 * sin(p.x * 0.006 + 1.3) * sin(p.y * 0.0075 + 0.7)
         + 2.8 * sin(p.x * 0.016 + 4.1) * sin(p.y * 0.013 + 2.4)
         + 1.2 * sin(p.x * 0.034 + 0.9) * sin(p.y * 0.029 + 3.3);
  }
`;

export const TERRAIN_GRAD_GLSL = `
  vec2 terrainGrad(vec2 p) {
    return vec2(
      5.5 * 0.006 * cos(p.x * 0.006 + 1.3) * sin(p.y * 0.0075 + 0.7)
        + 2.8 * 0.016 * cos(p.x * 0.016 + 4.1) * sin(p.y * 0.013 + 2.4)
        + 1.2 * 0.034 * cos(p.x * 0.034 + 0.9) * sin(p.y * 0.029 + 3.3),
      5.5 * 0.0075 * sin(p.x * 0.006 + 1.3) * cos(p.y * 0.0075 + 0.7)
        + 2.8 * 0.013 * sin(p.x * 0.016 + 4.1) * cos(p.y * 0.013 + 2.4)
        + 1.2 * 0.029 * sin(p.x * 0.034 + 0.9) * cos(p.y * 0.029 + 3.3));
  }
`;

// 残骸池(原 Bv):阵亡坦克烧黑车体的长期留场渲染。
// 单 InstancedMesh + 交错实例缓冲(x, z, heading, deathTime, scale),GPU 按地形落位、
// 随时间烧黑并在后期缓慢下沉;环形缓冲满后覆写最旧残骸。
// 另含 withPaintBrightness(原 Hv):为简单几何体补常数明度 color 属性,供碎片池使用。
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  BufferAttribute,
  ShaderMaterial,
  Mesh,
  DynamicDrawUsage,
} from 'three';
import { CONFIG } from '../../core/config.js';
import { TERRAIN_HEIGHT_GLSL } from '../../world/terrain.js';
import { SHADING_GLSL, CLOUD_SHADE_GLSL } from '../shading-glsl.js';
import { buildPlainMbtHull } from '../../models/mbt.js';

// 原 Lv:每实例浮点数(x, z, heading, deathTime, scale)
const FLOATS_PER_WRECK = 5;

// 原 Rv:残骸顶点着色器
const WRECK_VERT = `
  uniform float uNow;
  attribute vec3 aPaint;   // paint mask (renamed from 'color' to avoid USE_COLOR injection)
  attribute vec4 iW; // x, z, heading, deathTime
  attribute float iScale;
  varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld;
  vec3 rotY(vec3 p, float h) {
    float c = cos(h), s = sin(h);
    return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  }
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    float age = uNow - iW.w;
    if (age < 0.0) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); return; }
    float sink = clamp((age - 9.0) / 6.0, 0.0, 1.0) * 2.4 * iScale; // 巨炮 AOE 下尸量大,早些下沉
    vec3 p = vec3(iW.x, terrainH(iW.xy) - sink, iW.y) + rotY(position * iScale, iW.z);
    vNormal = rotY(normal, iW.z);
    vWorld = p;
    float char = clamp(age / 2.0, 0.0, 1.0); // 烧黑:留出锈棕底色,残骸带不再糊成纯黑
    vColor = mix(vec3(0.26, 0.24, 0.22), vec3(0.16, 0.125, 0.10), char) + aPaint.r * vec3(0.035, 0.02, 0.012);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// 原 zv:残骸片元着色器
const WRECK_FRAG = `
  uniform sampler2D uLightGrid;
  uniform float uNow;
  varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld;
  ${SHADING_GLSL}
  ${CLOUD_SHADE_GLSL}
  void main() {
    vec3 n = normalize(vNormal);
    vec3 albedo = pow(vColor, vec3(2.2));
    vec3 L = normalize(vec3(0.5, 0.475, 0.3)); // 与场景太阳方向一致
    vec3 V = normalize(cameraPosition - vWorld);
    float ndl = max(dot(n, L), 0.0);
    vec3 sunCol = vec3(1.0, 0.93, 0.80) * 2.4;
    float spec = pow(max(dot(n, normalize(L + V)), 0.0), 16.0) * 0.12;
    vec3 dyn = texture2D(uLightGrid, vWorld.xz / vec2(${CONFIG.mapW}.0, ${CONFIG.mapH}.0)).rgb;
    vec3 col = albedo * (ambient3(n) + sunCol * ndl) + sunCol * spec
             + (albedo * 0.8 + vec3(0.2)) * dyn;
    col *= cloudShade(vWorld.xz, uNow);
    col = acesTonemap(col);
    col = pow(col, vec3(1.0 / 2.2));
    // 距离雾(常量须与 main.ts 的 scene.fog 同步)
    float fd = length(cameraPosition - vWorld) * 0.0007;
    col = mix(col, vec3(0.067, 0.082, 0.106), 1.0 - exp(-fd * fd));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// 原 Hv:给几何体写入常数明度的 color 顶点属性(只填 g 通道,实例几何里映射为 aPaint)。
export function withPaintBrightness(geom, brightness) {
  const count = geom.getAttribute(`position`).count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors[i * 3 + 1] = brightness;
  geom.setAttribute(`color`, new BufferAttribute(colors, 3));
  return geom;
}

// 原 Bv
export class WreckPool {
  cap;
  mesh;
  buffer;
  head = 0;
  mat;
  geo;
  // flashTex = GroundFlashMap 的地面炮火光斑贴图(uLightGrid,按 vWorld.xz/地图尺寸采样)
  constructor(scene, flashTex, cap = 16384) {
    this.cap = cap;
    const data = new Float32Array(cap * FLOATS_PER_WRECK);
    // deathTime 预置为远古 → age 巨大 → 已完全下沉不可见;scale 预置 1
    for (let i = 0; i < cap; i++) {
      data[i * FLOATS_PER_WRECK + 3] = -1e9;
      data[i * FLOATS_PER_WRECK + 4] = 1;
    }
    this.buffer = new InstancedInterleavedBuffer(data, FLOATS_PER_WRECK);
    this.buffer.setUsage(DynamicDrawUsage);
    const hull = buildPlainMbtHull();
    const geo = new InstancedBufferGeometry();
    geo.index = hull.index;
    geo.setAttribute(`position`, hull.getAttribute(`position`));
    geo.setAttribute(`normal`, hull.getAttribute(`normal`));
    geo.setAttribute(`aPaint`, hull.getAttribute(`color`));
    geo.setAttribute(`iW`, new InterleavedBufferAttribute(this.buffer, 4, 0));
    geo.setAttribute(`iScale`, new InterleavedBufferAttribute(this.buffer, 1, 4));
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new ShaderMaterial({
      vertexShader: WRECK_VERT,
      fragmentShader: WRECK_FRAG,
      uniforms: { uNow: { value: 0 }, uLightGrid: { value: flashTex } },
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this.mesh = mesh;
  }

  // 环形覆写最旧残骸。参数顺序不可变:x, z, heading, deathTime, scale。
  spawn(x, z, heading, deathTime, scale = 1) {
    const o = (this.head++ % this.cap) * FLOATS_PER_WRECK;
    const arr = this.buffer.array;
    arr[o] = x;
    arr[o + 1] = z;
    arr[o + 2] = heading;
    arr[o + 3] = deathTime;
    arr[o + 4] = scale;
    this.geo.instanceCount = Math.min(this.head, this.cap);
    this.buffer.needsUpdate = true;
  }

  flush(now) {
    this.mat.uniforms.uNow.value = now;
  }
}

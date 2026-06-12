// 地面光斑累积图(GroundFlashMap)—— 炮口火光/爆炸在地面留下的瞬时光照。
//
// 设计要点:
// - 256×144 HalfFloat 渲染目标覆盖整张地图(mapW×mapH 米),正交无投影:
//   顶点着色器直接由世界 xz 算 NDC,相机只是占位的基类 Camera。
// - 每个光斑一个实例化 quad(环形缓冲,容量 cap,head 取模复用最旧槽),
//   iA=(x, z, t0, life)、iB=(radius, r, g, b);颜色已预乘强度。
// - 时间窗外的实例在顶点着色器里挤到裁剪域外,(1-t)² 淡出,片元 (1-r)² 径向衰减,
//   加性混合;每帧 update() 全量重绘到 RT,FleetRenderer/地面以 uLightGrid 采样。
// - dirtyMin/dirtyMax 跟踪本帧写入区间,只上传脏段。

import {
  Camera,
  DynamicDrawUsage,
  HalfFloatType,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  LinearFilter,
  Mesh,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  WebGLRenderTarget,
  AdditiveBlending,
} from 'three';
import { CONFIG } from '../core/config.js';

// 每个光斑占用的 float 数(iA vec4 + iB vec4)
export const FLOATS_PER_SPLAT = 8;

const SPLAT_VERT_GLSL = `
  uniform float uNow;
  attribute vec4 iA;   // x, z, t0, life
  attribute vec4 iB;   // radius, r, g, b
  varying vec2 vUvc;
  varying vec3 vCol;
  void main() {
    float t = (uNow - iA.z) / iA.w;
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); vUvc = vec2(0.0); vCol = vec3(0.0); return; }
    float fade = (1.0 - t) * (1.0 - t);
    vCol = iB.yzw * fade;
    vUvc = position.xy * 2.0; // quad ±0.5 → ±1
    vec2 w = vec2(iA.x, iA.y) + position.xy * iB.x * 2.0;
    gl_Position = vec4(w.x / ${CONFIG.mapW}.0 * 2.0 - 1.0, w.y / ${CONFIG.mapH}.0 * 2.0 - 1.0, 0.0, 1.0);
  }
`;

const SPLAT_FRAG_GLSL = `
  varying vec2 vUvc;
  varying vec3 vCol;
  void main() {
    float r = length(vUvc);
    float a = max(1.0 - r, 0.0);
    gl_FragColor = vec4(vCol * a * a, 1.0);
  }
`;

export class GroundFlashMap {
  cap;
  texture;
  rt;
  scene = new Scene();
  cam = new Camera();
  buffer;
  geo;
  mat;
  head = 0;
  dirtyMin = 1 / 0;
  dirtyMax = -1 / 0;

  constructor(cap = 8192) {
    this.cap = cap;
    this.rt = new WebGLRenderTarget(256, 144, {
      type: HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    this.texture = this.rt.texture;
    const data = new Float32Array(cap * FLOATS_PER_SPLAT);
    // life 预填 0.001:空槽 t 立即 >1,被顶点着色器剔除(也避免除零)
    for (let i = 0; i < cap; i++) data[i * FLOATS_PER_SPLAT + 3] = 0.001;
    this.buffer = new InstancedInterleavedBuffer(data, FLOATS_PER_SPLAT);
    this.buffer.setUsage(DynamicDrawUsage);
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute(`position`, quad.getAttribute(`position`));
    this.geo.setAttribute(`iA`, new InterleavedBufferAttribute(this.buffer, 4, 0));
    this.geo.setAttribute(`iB`, new InterleavedBufferAttribute(this.buffer, 4, 4));
    this.geo.instanceCount = 0;
    this.mat = new ShaderMaterial({
      vertexShader: SPLAT_VERT_GLSL,
      fragmentShader: SPLAT_FRAG_GLSL,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: AdditiveBlending,
      uniforms: { uNow: { value: 0 } },
    });
    const mesh = new Mesh(this.geo, this.mat);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
  }

  // 写入一个光斑(环形复用最旧槽);颜色按强度预乘后存储
  spawn(x, z, t0, life, radius, intensity, r = 1, g = 0.62, b = 0.3) {
    const o = (this.head++ % this.cap) * FLOATS_PER_SPLAT;
    const arr = this.buffer.array;
    arr[o] = x;
    arr[o + 1] = z;
    arr[o + 2] = t0;
    arr[o + 3] = life;
    arr[o + 4] = radius;
    arr[o + 5] = r * intensity;
    arr[o + 6] = g * intensity;
    arr[o + 7] = b * intensity;
    this.geo.instanceCount = Math.min(this.head, this.cap);
    if (o < this.dirtyMin) this.dirtyMin = o;
    if (o + FLOATS_PER_SPLAT > this.dirtyMax) this.dirtyMax = o + FLOATS_PER_SPLAT;
  }

  // 每帧:上传脏段后把全部活跃光斑重绘进 RT(加性叠加在清空的黑底上)
  update(renderer, now) {
    this.mat.uniforms.uNow.value = now;
    if (this.dirtyMax > 0 && this.dirtyMin < 1 / 0) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin);
      this.buffer.needsUpdate = true;
    }
    this.dirtyMin = 1 / 0;
    this.dirtyMax = -1 / 0;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0, 1);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(prev);
  }
}

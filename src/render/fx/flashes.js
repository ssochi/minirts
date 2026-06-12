// 地面闪光/痕迹两池。命名判断依据(与词汇表核对后,两类并未对调,按契约名导出):
// - FlashPool(原 b_):短寿命加性辉光贴地片,iMeta.y=kind——0/1 为橙色炮火光斑(寿命
//   0.35/0.75s),2 为巨炮冲击波(片元分支"白热扩张环 + 中心闪光",寿命 0.9s);
//   即"冲击波环"实际是 FlashPool 的 kind 2,环的扩张在片元里按 vT 做。
// - ShockwavePool(原 w_):契约名保留,但实义是 28 秒长寿命暗色弹坑/焦痕贴片
//   (普通混合、renderOrder 1 垫底,片元注释"弹坑"),并非扩张环。
// 两类均为 interleaved 实例缓冲环形写入 + dirty range 上传,平面 quad 旋转 -90° 逐顶点贴地。
import {
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  ShaderMaterial,
  Mesh,
  DynamicDrawUsage,
  AdditiveBlending,
} from 'three';
import { TERRAIN_HEIGHT_GLSL } from '../../world/terrain.js';

// ---- FlashPool:炮火地面辉光 + 巨炮冲击波环 ----

// 每实例浮点数(原 __):iGlow(3) iMeta(2)
const FLASH_STRIDE = 5;

// 原 v_
const FLASH_VERTEX = `
  uniform float uNow;
  attribute vec3 iGlow;   // x, z, t0
  attribute vec2 iMeta;   // size, kind
  varying vec2 vUvc;
  varying float vFade;
  varying float vKind;
  varying float vT;
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    float life = iMeta.y < 0.5 ? 0.35 : iMeta.y < 1.5 ? 0.75 : 0.9;
    float t = (uNow - iGlow.z) / life;
    if (t < 0.0 || t > 1.0) {
      gl_Position = vec4(0.0, 0.0, -10.0, 1.0);
      vFade = 0.0; vUvc = vec2(0.0); vKind = 0.0; vT = 0.0; return;
    }
    vFade = (1.0 - t) * (1.0 - t);
    vKind = iMeta.y;
    vT = t;
    float s = iMeta.x * (iMeta.y < 1.5 ? mix(0.7, 1.25, t) : 1.0); // 环的扩张在片元里做
    vUvc = position.xz * 2.0; // ±1
    vec3 p = vec3(iGlow.x + position.x * s, 0.0, iGlow.y + position.z * s);
    p.y = terrainH(p.xz) + 0.1; // 逐顶点贴地
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// 原 y_
const FLASH_FRAGMENT = `
  varying vec2 vUvc;
  varying float vFade;
  varying float vKind;
  varying float vT;
  void main() {
    float r = length(vUvc);
    float a;
    vec3 c;
    if (vKind < 1.5) {
      a = max(1.0 - r, 0.0);
      a *= a * vFade;
      c = mix(vec3(1.0, 0.66, 0.25), vec3(1.0, 0.48, 0.14), vKind);
    } else {
      // 巨炮冲击波:白热扩张环 + 中心闪光
      float ring = exp(-pow((r - mix(0.05, 1.0, vT)) * 7.0, 2.0));
      float flash = max(1.0 - r * 3.0, 0.0) * max(1.0 - vT * 4.0, 0.0);
      a = (ring + flash) * (1.0 - vT);
      c = vec3(1.0, 0.92, 0.75);
    }
    if (a < 0.004) discard;
    gl_FragColor = vec4(c * a * 1.7, a);
  }
`;

// 原 b_
export class FlashPool {
  cap;
  mesh;
  buffer;
  head = 0; // 环形写入游标(只增,取模定位)
  mat;
  geo;
  dirtyMin = Infinity; // 本帧脏区间,flush 时一次性上传
  dirtyMax = -Infinity;

  constructor(scene, cap = 16384) {
    this.cap = cap;
    const data = new Float32Array(cap * FLASH_STRIDE);
    for (let i = 0; i < cap; i++) data[i * FLASH_STRIDE + 2] = -1e9; // t0=-1e9:初始全部失效
    this.buffer = new InstancedInterleavedBuffer(data, FLASH_STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
    const quad = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), // 平躺地面
      geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('iGlow', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('iMeta', new InterleavedBufferAttribute(this.buffer, 2, 3));
    geo.instanceCount = 0; // 随 spawn 增长到 cap 封顶
    this.geo = geo;
    this.mat = new ShaderMaterial({
      vertexShader: FLASH_VERTEX,
      fragmentShader: FLASH_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uNow: { value: 0 } },
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    scene.add(mesh);
    this.mesh = mesh;
  }

  // kind: 0/1=橙色炮火光斑(色调/寿命两档) 2=巨炮冲击波环
  spawn(x, z, t0, size, kind) {
    const at = (this.head++ % this.cap) * FLASH_STRIDE,
      a = this.buffer.array;
    a[at] = x;
    a[at + 1] = z;
    a[at + 2] = t0;
    a[at + 3] = size;
    a[at + 4] = kind;
    this.geo.instanceCount = Math.min(this.head, this.cap);
    if (at < this.dirtyMin) this.dirtyMin = at;
    if (at + FLASH_STRIDE > this.dirtyMax) this.dirtyMax = at + FLASH_STRIDE;
  }

  flush(now) {
    this.mat.uniforms.uNow.value = now;
    if (this.dirtyMax > 0 && this.dirtyMin < Infinity) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin);
      this.buffer.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }
}

// ---- ShockwavePool(实义:重炮弹坑/焦痕,28 秒淡出) ----

// 每实例浮点数(原 x_):iGlow(3) iSize(1)
const WAVE_STRIDE = 4;

// 原 S_
const WAVE_VERTEX = `
  uniform float uNow;
  attribute vec3 iGlow;   // x, z, t0
  attribute float iSize;
  varying vec2 vUvc;
  varying float vFade;
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    float age = uNow - iGlow.z;
    if (age < 0.0 || age > 28.0) {
      gl_Position = vec4(0.0, 0.0, -10.0, 1.0); vUvc = vec2(0.0); vFade = 0.0; return;
    }
    vFade = 1.0 - smoothstep(12.0, 28.0, age);
    vUvc = position.xz * 2.0;
    vec3 p = vec3(iGlow.x + position.x * iSize, 0.0, iGlow.y + position.z * iSize);
    p.y = terrainH(p.xz) + 0.07; // 逐顶点贴地
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// 原 C_
const WAVE_FRAGMENT = `
  varying vec2 vUvc;
  varying float vFade;
  void main() {
    float r = length(vUvc);
    // 中心深、外围快速衰减:读作"弹坑"而不是糊满地面的黑斑
    float a = (1.0 - smoothstep(0.18, 0.95, r)) * 0.34 * vFade;
    if (a < 0.004) discard;
    gl_FragColor = vec4(0.03, 0.025, 0.02, a);
  }
`;

// 原 w_
export class ShockwavePool {
  cap;
  mesh;
  buffer;
  head = 0; // 环形写入游标(只增,取模定位)
  mat;
  geo;
  dirtyMin = Infinity; // 本帧脏区间,flush 时一次性上传
  dirtyMax = -Infinity;

  constructor(scene, cap = 4096) {
    this.cap = cap;
    const data = new Float32Array(cap * WAVE_STRIDE);
    for (let i = 0; i < cap; i++) data[i * WAVE_STRIDE + 2] = -1e9; // t0=-1e9:初始全部失效
    this.buffer = new InstancedInterleavedBuffer(data, WAVE_STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
    const quad = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), // 平躺地面
      geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('iGlow', new InterleavedBufferAttribute(this.buffer, 3, 0));
    geo.setAttribute('iSize', new InterleavedBufferAttribute(this.buffer, 1, 3));
    geo.instanceCount = 0; // 随 spawn 增长到 cap 封顶
    this.geo = geo;
    this.mat = new ShaderMaterial({
      vertexShader: WAVE_VERTEX,
      fragmentShader: WAVE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // 原码未设 blending:保持默认 NormalBlending(暗色焦痕要"压暗"地面,不能加性)
      uniforms: { uNow: { value: 0 } },
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    scene.add(mesh);
    this.mesh = mesh;
  }

  spawn(x, z, t0, size) {
    const at = (this.head++ % this.cap) * WAVE_STRIDE,
      a = this.buffer.array;
    a[at] = x;
    a[at + 1] = z;
    a[at + 2] = t0;
    a[at + 3] = size;
    this.geo.instanceCount = Math.min(this.head, this.cap);
    if (at < this.dirtyMin) this.dirtyMin = at;
    if (at + WAVE_STRIDE > this.dirtyMax) this.dirtyMax = at + WAVE_STRIDE;
  }

  flush(now) {
    this.mat.uniforms.uNow.value = now;
    if (this.dirtyMax > 0 && this.dirtyMin < Infinity) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin);
      this.buffer.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
  }
}

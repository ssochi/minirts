// GPU 粒子池(原 u_):单条 interleaved 实例缓冲(stride=10)环形写入,CPU 只管 spawn
// 写入与 flush 时的 dirty range 一次性上传;寿命/重力/缩放/颜色全部在顶点着色器按 iKind
// 分支无状态求值,死粒子被抛到裁剪空间外,instanceCount 恒为 cap。
// glow=true 时附加光晕重绘通道:同几何同缓冲再画一遍,uHalo=1 放大+压暗(假 bloom)。
import {
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  InstancedBufferGeometry,
  PlaneGeometry,
  ShaderMaterial,
  Mesh,
  DynamicDrawUsage,
  AdditiveBlending,
  NormalBlending,
} from 'three';
import { TERRAIN_HEIGHT_GLSL } from '../../world/terrain.js';
import { getNoiseTexture } from '../noise-texture.js';

// 每实例浮点数(原 s_):iPos(3) iTime(1) iVel(3) iKind(1) iSize(1) iSeed(1)
const STRIDE = 10;

// 原 c_
const VERTEX = `
  uniform float uNow;
  uniform float uHalo;  // >0:光晕重绘通道——放大 + 压暗,给火光/弹丸出辉光(假 bloom)
  attribute vec3 iPos;
  attribute float iTime;
  attribute vec3 iVel;
  attribute float iKind;
  attribute float iSize;
  attribute float iSeed;
  varying vec4 vCol;
  varying vec2 vUv;

  ${TERRAIN_HEIGHT_GLSL}
  // 每种粒子:寿命(s)、重力、起止色、alpha 曲线;kind4=巨炮炮弹(寿命=iSeed,带弹道弧)
  void main() {
    float age = uNow - iTime;
    float life = iKind < 0.5 ? 1.6 : iKind < 1.5 ? 0.12 : iKind < 2.5 ? 0.5
               : iKind < 3.5 ? 2.2 : max(iSeed, 0.05);
    float t = age / life;
    if (t < 0.0 || t > 1.0) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); vCol = vec4(0.0); return; }
    float grav = iKind < 1.5 ? 0.0 : iKind < 2.5 ? -2.0 : iKind < 3.5 ? 1.2
               : iKind < 4.5 ? -3.0 : 0.0; // 巨炮弹道弧;磁轨弹直线
    // CPU spawn 传的是相对地面高度;贴地偏移按出生点采样(快弹掠过山头的偏差可接受)
    float gy = terrainH(iPos.xz);
    vec3 wp = iPos + iVel * age;
    wp.y += 0.5 * grav * age * age + gy;
    wp.y = max(wp.y, gy + 0.2);
    float grow = iKind < 0.5 ? mix(0.6, 1.8, t)            // 尘土膨胀
               : iKind < 1.5 ? mix(1.2, 0.4, t)            // 炮口焰收缩
               : iKind < 2.5 ? mix(0.5, 1.6, sqrt(t))      // 火球爆开
               : iKind < 3.5 ? mix(0.8, 2.4, t)            // 烟膨胀
               : 1.0;                                       // 炮弹
    float a = iKind < 0.5 ? 0.22 * (1.0 - t)
            : iKind < 1.5 ? 0.9 * (1.0 - t)
            : iKind < 2.5 ? 0.85 * (1.0 - t * t)
            : iKind < 3.5 ? 0.35 * (1.0 - t)
            : 1.0;
    vec3 c0 = iKind < 0.5 ? vec3(0.45, 0.42, 0.36)
            : iKind < 1.5 ? vec3(1.0, 0.85, 0.4)
            : iKind < 2.5 ? vec3(1.0, 0.55, 0.15)
            : iKind < 3.5 ? vec3(0.25, 0.24, 0.23)
            : iKind < 4.5 ? vec3(1.0, 0.8, 0.45)
            : vec3(0.55, 0.85, 1.0);            // 磁轨弹:青白电弧色
    vec3 c1 = iKind < 2.5 ? c0 * 0.6 : c0;
    vCol = vec4(mix(c0, c1, t), a * (1.0 - 0.85 * uHalo));
    vec4 mv = modelViewMatrix * vec4(wp, 1.0);
    // billboard:position 是 ±0.5 quad 角点
    float spin = iSeed * 6.28 + t * (iKind < 0.5 ? 1.0 : 3.0);
    float cs = cos(spin), sn = sin(spin);
    vec2 corner = mat2(cs, -sn, sn, cs) * position.xy;
    vUv = corner + 0.5; // 旋转后的角点映射 uv,贴图随粒子自旋(边缘 alpha=0,越界 clamp 安全)
    mv.xy += corner * iSize * grow * (1.0 + 1.5 * uHalo);
    gl_Position = projectionMatrix * mv;
  }
`;

// 原 l_
const FRAGMENT = `
  uniform sampler2D uMap;
  varying vec4 vCol;
  varying vec2 vUv;
  void main() {
    float t = texture2D(uMap, vUv).a; // 软圆 + 噪声破边:色块 → 气体
    float a = vCol.a * t;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vCol.rgb, a);
  }
`;

// 原 u_
export class ParticlePool {
  cap;
  meshes = [];
  buffer;
  geo;
  mat;
  haloMat = null;
  head = 0; // 环形写入游标:只增不减,取模 cap 定位,写满后覆盖最旧粒子
  dirtyMin = Infinity; // 本帧脏区间 [dirtyMin, dirtyMax),flush 时一次性上传
  dirtyMax = -Infinity;
  count = 0; // 本帧 spawn 计数(HUD 统计用,flush 清零)

  constructor(scene, cap, glow) {
    this.cap = cap;
    const data = new Float32Array(cap * STRIDE);
    for (let i = 0; i < cap; i++) data[i * STRIDE + 3] = -1e9; // iTime=-1e9:初始全部"早已死亡"
    this.buffer = new InstancedInterleavedBuffer(data, STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
    const quad = new PlaneGeometry(1, 1);
    this.geo = new InstancedBufferGeometry();
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    const attr = (name, size, offset) =>
      this.geo.setAttribute(name, new InterleavedBufferAttribute(this.buffer, size, offset));
    attr('iPos', 3, 0);
    attr('iTime', 1, 3);
    attr('iVel', 3, 4);
    attr('iKind', 1, 7);
    attr('iSize', 1, 8);
    attr('iSeed', 1, 9);
    this.geo.instanceCount = cap; // 恒满量绘制,死粒子在顶点着色器里抛出屏外
    this.mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: glow ? AdditiveBlending : NormalBlending,
      uniforms: { uNow: { value: 0 }, uHalo: { value: 0 }, uMap: { value: getNoiseTexture() } },
    });
    const mesh = new Mesh(this.geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = glow ? 11 : 10;
    scene.add(mesh);
    this.meshes.push(mesh);
    if (glow) {
      // 光晕通道:同一几何/缓冲再画一遍,uHalo=1(放大 1+1.5 倍、alpha 压到 15%),加性叠出辉光
      this.haloMat = new ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        uniforms: { uNow: { value: 0 }, uHalo: { value: 1 }, uMap: { value: getNoiseTexture() } },
      });
      const halo = new Mesh(this.geo, this.haloMat);
      halo.frustumCulled = false;
      halo.renderOrder = 12;
      scene.add(halo);
      this.meshes.push(halo);
    }
  }

  // kind: 0=尘土 1=炮口焰 2=火球 3=烟 4=巨炮炮弹 5=磁轨弹;
  // kind 4/5 的 seed 即飞行时间(着色器里 life=iSeed),其余 kind 留空则随机(自旋相位)
  spawn(x, y, z, t0, vx, vy, vz, kind, size, seed) {
    const at = (this.head++ % this.cap) * STRIDE,
      a = this.buffer.array;
    a[at] = x;
    a[at + 1] = y;
    a[at + 2] = z;
    a[at + 3] = t0;
    a[at + 4] = vx;
    a[at + 5] = vy;
    a[at + 6] = vz;
    a[at + 7] = kind;
    a[at + 8] = size;
    a[at + 9] = seed ?? Math.random();
    if (at < this.dirtyMin) this.dirtyMin = at;
    if (at + STRIDE > this.dirtyMax) this.dirtyMax = at + STRIDE;
    this.count++;
  }

  flush(now) {
    this.mat.uniforms.uNow.value = now;
    if (this.haloMat) this.haloMat.uniforms.uNow.value = now;
    if (this.dirtyMax > 0 && this.dirtyMin < Infinity) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(this.dirtyMin, this.dirtyMax - this.dirtyMin);
      this.buffer.needsUpdate = true;
    }
    this.dirtyMin = Infinity;
    this.dirtyMax = -Infinity;
    this.count = 0;
  }
}

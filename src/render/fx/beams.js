// 曳光/光束池(原 h_):每发炮弹一条 from→to 的低抛物线曳光,位置随 (uNow-t0)/flightSec
// 在着色器内插值,端点各自贴地。interleaved 缓冲(stride=6)环形写入 + dirty range 上传;
// 主通道 + 光晕通道(uHalo=1 放大压暗)双 mesh 共享同一几何,均为加性混合。
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
import { getNoiseTexture } from '../noise-texture.js';

// 每实例浮点数(原 f_):iLine(4) iTiming(2)
const STRIDE = 6;

// 原 p_
const VERTEX = `
  uniform float uNow;
  uniform float uHalo;   // >0:光晕重绘(放大+压暗)
  attribute vec4 iLine;  // fromX, fromZ, toX, toZ
  attribute vec2 iTiming; // t0, flightSec
  varying float vA;
  varying vec2 vUv;
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    vUv = position.xy + 0.5;
    float p = (uNow - iTiming.x) / iTiming.y;
    if (p < 0.0 || p > 1.0) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); vA = 0.0; return; }
    vec2 g = mix(iLine.xy, iLine.zw, p);
    // 低抛物线;端点各自贴地,飞越起伏地形不入土
    float y = mix(terrainH(iLine.xy), terrainH(iLine.zw), p) + 1.7 + sin(p * 3.14159) * 2.0;
    vA = 0.9 * (1.0 - 0.82 * uHalo);
    vec4 mv = modelViewMatrix * vec4(g.x, y, g.y, 1.0);
    mv.xy += position.xy * vec2(1.4, 0.35) * (1.0 + 1.8 * uHalo); // 拉长的光斑
    gl_Position = projectionMatrix * mv;
  }
`;

// 原 m_
const FRAGMENT = `
  uniform sampler2D uMap;
  varying float vA;
  varying vec2 vUv;
  void main() {
    float t = texture2D(uMap, vUv).a; // 软光斑:硬边方点 → 曳光辉点
    if (vA * t < 0.004) discard;
    gl_FragColor = vec4(1.0, 0.9, 0.55, vA * t);
  }
`;

// 原 h_
export class BeamPool {
  cap;
  meshes = [];
  buffer;
  head = 0; // 环形写入游标(只增,取模定位)
  mat;
  haloMat;
  geo;
  dirtyMin = Infinity; // 本帧脏区间,flush 时一次性上传
  dirtyMax = -Infinity;
  count = 0; // 本帧 spawn 计数,flush 清零

  constructor(scene, cap = 16384) {
    this.cap = cap;
    const data = new Float32Array(cap * STRIDE);
    for (let i = 0; i < cap; i++) data[i * STRIDE + 4] = -1e9; // iTiming.x(t0)=-1e9:初始全部失效
    this.buffer = new InstancedInterleavedBuffer(data, STRIDE);
    this.buffer.setUsage(DynamicDrawUsage);
    const quad = new PlaneGeometry(1, 1),
      geo = new InstancedBufferGeometry();
    geo.index = quad.index;
    geo.setAttribute('position', quad.getAttribute('position'));
    geo.setAttribute('iLine', new InterleavedBufferAttribute(this.buffer, 4, 0));
    geo.setAttribute('iTiming', new InterleavedBufferAttribute(this.buffer, 2, 4));
    geo.instanceCount = 0; // 随 spawn 增长到 cap 封顶
    this.geo = geo;
    this.mat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uNow: { value: 0 }, uHalo: { value: 0 }, uMap: { value: getNoiseTexture() } },
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 12;
    scene.add(mesh);
    this.meshes.push(mesh);
    this.haloMat = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      uniforms: { uNow: { value: 0 }, uHalo: { value: 1 }, uMap: { value: getNoiseTexture() } },
    });
    const halo = new Mesh(geo, this.haloMat);
    halo.frustumCulled = false;
    halo.renderOrder = 13;
    scene.add(halo);
    this.meshes.push(halo);
  }

  spawn(fromX, fromZ, toX, toZ, t0, flightSec) {
    const at = (this.head++ % this.cap) * STRIDE,
      a = this.buffer.array;
    a[at] = fromX;
    a[at + 1] = fromZ;
    a[at + 2] = toX;
    a[at + 3] = toZ;
    a[at + 4] = t0;
    a[at + 5] = flightSec;
    this.geo.instanceCount = Math.min(this.head, this.cap);
    if (at < this.dirtyMin) this.dirtyMin = at;
    if (at + STRIDE > this.dirtyMax) this.dirtyMax = at + STRIDE;
    this.count++;
  }

  flush(now) {
    this.mat.uniforms.uNow.value = now;
    this.haloMat.uniforms.uNow.value = now;
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

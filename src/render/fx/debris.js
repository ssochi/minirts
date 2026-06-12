// 碎片池(原 Jv):坦克殉爆抛出的炮塔/装甲板/负重轮/履带四类刚体碎片。
// 运动全程在顶点着色器解析求解:第一段抛物线 + 落地一次反弹 + 第二段落回即停,CPU 只写出生参数。
// 每类碎片各占一个 FragmentPool(原 qv,InstancedMesh + 交错缓冲 iA/iB/iC),环形覆写最旧实例。
import {
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  ShaderMaterial,
  Mesh,
  BoxGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
} from 'three';
import { CONFIG } from '../../core/config.js';
import { terrainHeight, TERRAIN_HEIGHT_GLSL } from '../../world/terrain.js';
import { SHADING_GLSL, CLOUD_SHADE_GLSL } from '../shading-glsl.js';
import { buildMbtTurret } from '../../models/mbt.js';
import { withPaintBrightness } from './wrecks.js';

// 原 Uv:每实例浮点数(iA: x,y,z,t0 | iB: vx,vy,vz,spin | iC: 自旋轴 xyz,scale)
const FLOATS_PER_FRAGMENT = 12;
// 原 Wv:碎片寿命(秒),尾段 3 秒内下沉消失
const FRAGMENT_LIFE = 12;

// 原 Gv:碎片顶点着色器(GPU 解析两段抛物线弹道)
const FRAGMENT_VERT = `
  uniform float uNow;
  attribute vec3 aPaint;   // g=明度(renamed from 'color' to avoid USE_COLOR injection)
  attribute vec4 iA;       // x, y, z, t0
  attribute vec4 iB;       // vx, vy, vz, spin(rad/s)
  attribute vec4 iC;       // 自旋轴(单位向量), scale
  varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld; varying vec3 vEmis;
  ${TERRAIN_HEIGHT_GLSL}
  vec3 rotAxis(vec3 p, vec3 ax, float a) {
    float c = cos(a), s = sin(a);
    return p * c + cross(ax, p) * s + ax * dot(ax, p) * (1.0 - c);
  }
  void main() {
    float age = uNow - iA.w;
    if (age < 0.0 || age > ${FRAGMENT_LIFE.toFixed(1)}) {
      gl_Position = vec4(0.0, 0.0, -10.0, 1.0);
      vColor = vec3(0.0); vNormal = vec3(0.0, 1.0, 0.0); vWorld = vec3(0.0); vEmis = vec3(0.0);
      return;
    }
    float G = ${(-22).toFixed(1)};
    float gy = terrainH(iA.xz) + 0.22 * iC.w; // 近似:用出生点地形当落点地形(飞行距离几米)
    // 第一段抛物线落地时刻(取正根;G<0)
    float disc = max(iB.y * iB.y - 2.0 * G * (iA.y - gy), 0.0);
    float t1 = (-iB.y - sqrt(disc)) / G;
    vec3 p; float ang;
    if (age < t1) {
      p = iA.xyz + iB.xyz * age; p.y += 0.5 * G * age * age;
      ang = iB.w * age;
    } else {
      // 落点起跳:水平速度 ×0.45,竖直反弹 ×0.35,角速度减半;第二段落回即停
      float vy1 = iB.y + G * t1;
      vec3 land = vec3(iA.x + iB.x * t1, gy, iA.z + iB.z * t1);
      vec3 v2 = vec3(iB.x * 0.45, -vy1 * 0.35, iB.z * 0.45);
      float a2 = age - t1, t2 = -2.0 * v2.y / G;
      if (a2 < t2) {
        p = land + v2 * a2; p.y += 0.5 * G * a2 * a2;
        ang = iB.w * (t1 + a2 * 0.5);
      } else {
        p = vec3(land.x + v2.x * t2, gy, land.z + v2.z * t2);
        ang = iB.w * (t1 + t2 * 0.5); // 落定停转
      }
    }
    p.y -= smoothstep(${(FRAGMENT_LIFE - 3).toFixed(1)}, ${FRAGMENT_LIFE.toFixed(1)}, age) * 1.6 * iC.w; // 尾段下沉
    vec3 wp = p + rotAxis(position * iC.w, iC.xyz, ang);
    vNormal = rotAxis(normal, iC.xyz, ang);
    vWorld = wp;
    vColor = mix(vec3(0.30, 0.28, 0.25), vec3(0.16, 0.13, 0.11), clamp(age / 2.0, 0.0, 1.0)) * aPaint.g;
    vEmis = vec3(1.0, 0.38, 0.10) * exp(-age * 1.7) * 0.9; // 灼热余烬,~1.5s 冷却
    gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
  }
`;

// 原 Kv:碎片片元着色器(同残骸,多一项 vEmis 余烬自发光)
const FRAGMENT_FRAG = `
  uniform sampler2D uLightGrid;
  uniform float uNow;
  varying vec3 vColor; varying vec3 vNormal; varying vec3 vWorld; varying vec3 vEmis;
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
             + (albedo * 0.8 + vec3(0.2)) * dyn + vEmis;
    col *= cloudShade(vWorld.xz, uNow);
    col = acesTonemap(col);
    col = pow(col, vec3(1.0 / 2.2));
    float fd = length(cameraPosition - vWorld) * 0.0007; // 与场景雾同步
    col = mix(col, vec3(0.067, 0.082, 0.106), 1.0 - exp(-fd * fd));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// 原 qv:单一形状的碎片实例池(模块内部类,不导出)。
class FragmentPool {
  cap;
  mesh;
  buffer;
  geo;
  mat;
  head = 0;
  constructor(scene, srcGeom, lightGridTex, cap) {
    this.cap = cap;
    const data = new Float32Array(cap * FLOATS_PER_FRAGMENT);
    // t0 预置为远古 → age 超寿命 → 不可见
    for (let i = 0; i < cap; i++) data[i * FLOATS_PER_FRAGMENT + 3] = -1e9;
    this.buffer = new InstancedInterleavedBuffer(data, FLOATS_PER_FRAGMENT);
    this.buffer.setUsage(DynamicDrawUsage);
    const geo = new InstancedBufferGeometry();
    geo.index = srcGeom.index;
    geo.setAttribute(`position`, srcGeom.getAttribute(`position`));
    geo.setAttribute(`normal`, srcGeom.getAttribute(`normal`));
    geo.setAttribute(`aPaint`, srcGeom.getAttribute(`color`));
    geo.setAttribute(`iA`, new InterleavedBufferAttribute(this.buffer, 4, 0));
    geo.setAttribute(`iB`, new InterleavedBufferAttribute(this.buffer, 4, 4));
    geo.setAttribute(`iC`, new InterleavedBufferAttribute(this.buffer, 4, 8));
    geo.instanceCount = 0;
    this.geo = geo;
    this.mat = new ShaderMaterial({
      vertexShader: FRAGMENT_VERT,
      fragmentShader: FRAGMENT_FRAG,
      uniforms: { uNow: { value: 0 }, uLightGrid: { value: lightGridTex } },
    });
    const mesh = new Mesh(geo, this.mat);
    mesh.frustumCulled = false;
    scene.add(mesh);
    this.mesh = mesh;
  }

  // 参数顺序不可变:x, y, z, t0, vx, vy, vz, spin, axisX, axisY, axisZ, scale
  spawn(x, y, z, t0, vx, vy, vz, spin, axisX, axisY, axisZ, scale) {
    const o = (this.head++ % this.cap) * FLOATS_PER_FRAGMENT;
    const arr = this.buffer.array;
    arr[o] = x;
    arr[o + 1] = y;
    arr[o + 2] = z;
    arr[o + 3] = t0;
    arr[o + 4] = vx;
    arr[o + 5] = vy;
    arr[o + 6] = vz;
    arr[o + 7] = spin;
    arr[o + 8] = axisX;
    arr[o + 9] = axisY;
    arr[o + 10] = axisZ;
    arr[o + 11] = scale;
    this.geo.instanceCount = Math.min(this.head, this.cap);
    this.buffer.needsUpdate = true;
  }

  flush(now) {
    this.mat.uniforms.uNow.value = now;
  }
}

// 原 Jv
export class DebrisPool {
  turret;
  plate;
  wheel;
  track;
  get meshes() {
    return [this.turret.mesh, this.plate.mesh, this.wheel.mesh, this.track.mesh];
  }
  // flashTex 实际喂给各池的 uLightGrid(地面炮火光斑贴图),与 WreckPool 同一纹理。
  constructor(scene, flashTex) {
    this.turret = new FragmentPool(scene, buildMbtTurret(false), flashTex, 2048);
    this.plate = new FragmentPool(scene, withPaintBrightness(new BoxGeometry(1.5, 0.1, 1), 0.9), flashTex, 4096);
    this.wheel = new FragmentPool(
      scene,
      withPaintBrightness(new CylinderGeometry(0.44, 0.44, 0.3, 6).rotateX(Math.PI / 2), 0.5),
      flashTex,
      4096,
    );
    this.track = new FragmentPool(scene, withPaintBrightness(new BoxGeometry(1.9, 0.22, 0.62), 0.45), flashTex, 2048);
  }

  // 朝随机水平方向抛出一枚碎片:水平速度 ×(0.5~1.5),竖直 ×(0.75~1.25),自旋 ×(0.6~1.4),自旋轴球面均匀随机。
  fling(pool, x, y, z, t0, hSpeed, vSpeed, spin, scale) {
    const dir = Math.random() * Math.PI * 2;
    const speed = hSpeed * (0.5 + Math.random());
    const axisY = Math.random() * 2 - 1;
    const axisXZ = Math.sqrt(1 - axisY * axisY);
    const axisAng = Math.random() * Math.PI * 2;
    pool.spawn(
      x,
      y,
      z,
      t0,
      Math.cos(dir) * speed,
      vSpeed * (0.75 + Math.random() * 0.5),
      Math.sin(dir) * speed,
      spin * (0.6 + Math.random() * 0.8),
      axisXZ * Math.cos(axisAng),
      axisY,
      axisXZ * Math.sin(axisAng),
      scale,
    );
  }

  // 地面殉爆:1 炮塔 + 3/5 装甲板 + 2 负重轮 + 1 履带。big=true(巨型单位)时速度 ×1.35、装甲板 5 块。
  burst(x, z, t0, scale, big) {
    const y = terrainHeight(x, z) + 1.1 * scale;
    const boost = big ? 1.35 : 1;
    this.fling(this.turret, x, y, z, t0, 2.5 * boost, 11 * boost, 4, scale);
    const plates = big ? 5 : 3;
    for (let i = 0; i < plates; i++)
      this.fling(this.plate, x, y, z, t0, 7 * boost, 8 * boost, 9, scale * (0.7 + Math.random() * 0.6));
    for (let i = 0; i < 2; i++) this.fling(this.wheel, x, y, z, t0, 8 * boost, 6.5 * boost, 11, scale);
    this.fling(this.track, x, y, z, t0, 6 * boost, 7.5 * boost, 7, scale);
  }

  // 空中爆炸(无人机等):离地 height 处抛 2 轮 + 1 板,初速小、自旋快。
  burstAir(x, z, height, t0, scale) {
    const y = terrainHeight(x, z) + height;
    for (let i = 0; i < 2; i++) this.fling(this.wheel, x, y, z, t0, 4, 2, 12, scale);
    this.fling(this.plate, x, y, z, t0, 3, 1.5, 8, scale * 0.8);
  }

  flush(now) {
    this.turret.flush(now);
    this.plate.flush(now);
    this.wheel.flush(now);
    this.track.flush(now);
  }
}

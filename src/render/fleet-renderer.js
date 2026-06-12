// 全军实例化渲染器(FleetRenderer)—— 本游戏最核心的渲染模块。
//
// 设计要点:
// - LOD 两档:每兵种各建一套"远档"(低模,容量 cap,可达 maxUnits)与"近档"
//   (高模,容量 nearCap 很小)实例缓冲;uploadSnapshot 按"距相机焦点 < NEAR_RADIUS
//   且近档未满"决定该单位进近档(高模),否则落远档(低模),近档满了退回远档。
// - 实例数据即快照记录:每单位 10 个 float(SNAP_STRIDE,见 sim/protocol.js)直接
//   memcpy 进交错缓冲,iPrev/iCurr/iMeta 三个 InterleavedBufferAttribute 共享同一缓冲,
//   顶点着色器在两帧快照间插值(位置 mix、角度 lerpAngle)。
// - aTile 图集寻址:几何体每顶点带 aTile=(u0,v0,su,sv) 瓦片矩形,片元用
//   uv0 + fract(局部重复坐标) * 矩形尺寸 采样手绘装甲图集(gutter 防 mip 渗色)。
// - aAnim 动画通道编码(无状态顶点动画):mode 1=负重轮绕局部 z 轴心(a,b)按里程/半径
//   自转、2=旋翼绕局部 y 轴定速旋转(w=rad/s)、3=履带纹理 u 随里程滚动(w=每米重复数);
//   里程 = 当前位置在车头方向上的投影,行驶即转、停车即停。
// - 后坐力:hpRecoil 小数位 × pow(0.55, uAlpha) 指数衰减插值,炮塔全额、车体 35%。
// - 阴影:全员 blob 椭圆假阴影(逐顶点贴地 + 选择环);近景另有 castShadow 网格
//   (customDepthMaterial 输出 packDepthToRGBA,onBeforeShadow 判定只对"单位影相机"
//   投影,不污染全图障碍阴影贴图),blob 在焦点附近淡出避免双重阴影。
// - uploadSnapshot 可传视锥地面四边形(8 个 float),用 4 条边叉积 + 35m 余量粗剔除。

import {
  Color,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
} from 'three';
import { CONFIG, KIND } from '../core/config.js';
import { TERRAIN_HEIGHT_GLSL } from '../world/terrain.js';
import { SHADING_GLSL, CLOUD_SHADE_GLSL } from './shading-glsl.js';
import { getHullAtlas } from './atlas/hull-atlas.js';
import { HULL_BUILDERS, TURRET_BUILDERS, MUZZLE_OFFSETS } from '../models/index.js';

// ---- 单位顶点着色器(车体与炮塔共用,uIsTurret 区分) ----
const UNIT_VERT_GLSL = `
  uniform float uAlpha;
  uniform float uIsTurret;
  uniform float uAlt;          // 飞行高度(地面单位 0)
  uniform float uNow;          // 渲染时钟(悬浮抖动)
  uniform float uRecoilK;      // 后坐位移幅度(米,炮塔全额、车体 35%)
  uniform vec3 uTurretPivot;
  uniform vec3 uTeamColors[2];   // 队色识别带(饱和)
  uniform vec3 uBodyColors[2];   // 军色车体(低饱和,暖橄榄 vs 冷钢灰)
  attribute vec3 aPaint;       // r=涂装掩码(0金属/1车体/2识别带) g=明度 b=自发光
  attribute vec4 aTile;        // 瓦片采样矩形(u0,v0,su,sv)
  attribute vec4 aAnim;        // 运动动画:mode(1轮/2旋翼/3履带), 轴心 a,b, 参数 w
  attribute vec4 iPrev;        // x, z, heading, turretYaw
  attribute vec4 iCurr;
  attribute vec2 iMeta;        // team+kind*2, hp01
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vEmis;
  varying float vSel;
  varying vec2 vUv;       // 局部重复坐标(平铺瓦 >1 重复,徽记瓦 0..1)
  varying vec4 vTile;     // 瓦片采样矩形
  varying float vAccent;  // 队色区标记:纹理减淡(深缝×队色≈黑斑,SC2 式队色面板要干净)

  float lerpAngle(float a, float b, float t) {
    float d = mod(b - a + 3.14159265, 6.2831853) - 3.14159265;
    return a + d * t;
  }
  // convention: forward=(cos h, sin h)->(x,z). rotation matrix on (x,z) plane:
  vec3 rotY(vec3 p, float h) {
    float c = cos(h), s = sin(h);
    return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  }
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    float h = lerpAngle(iPrev.z, iCurr.z, uAlpha);
    vec2 ground = mix(iPrev.xy, iCurr.xy, uAlpha);
    // 小数部分 = 稳定单位种子(≤0.246,重排不变,悬浮相位/明度抖动不跳变)+ 选中位(+0.5)
    float f = fract(iMeta.x);
    vSel = step(0.5, f);
    float seed = (f - 0.5 * vSel) * 256.0;
    float alt = uAlt > 0.0 ? uAlt + sin(uNow * 2.0 + seed * 1.71) * 0.6 : 0.0;
    vec3 base = vec3(ground.x, alt + terrainH(ground), ground.y);
    // 后坐回弹:开火瞬间 recoil=1,模拟每 tick ×0.55;pow(0.55,uAlpha) 指数插值
    // 与两端快照精确衔接,炮塔沿炮口反方向猛缩后弹回,车体跟着矮幅一坐
    float ty = lerpAngle(iPrev.w, iCurr.w, uAlpha);
    float rec = fract(iMeta.y) * pow(0.55, uAlpha) * uRecoilK;
    vec3 kick = rotY(vec3(-1.0, 0.0, 0.0), ty);
    // ---- 运动动画(无状态):里程 = 当前位置在车头方向上的投影,
    // 车轮转角/履带滚动随里程变化——行驶即转、停车即停、无累计状态
    float ch = cos(h), sh2 = sin(h);
    float along = ground.x * ch + ground.y * sh2;
    vec3 lp = position; vec3 lnrm = normal; vec2 uvL = uv;
    if (aAnim.x > 2.5) {            // 履带:纹理 u 随里程滚动(w=每米重复数)
      uvL.x -= along * aAnim.w;
    } else if (aAnim.x > 1.5) {     // 旋翼:绕局部 y 轴定速旋转(w=rad/s,正负=旋向)
      float ang = uNow * aAnim.w;
      float c2 = cos(ang), s2 = sin(ang);
      vec2 d2 = lp.xz - aAnim.yz;
      lp.xz = aAnim.yz + vec2(d2.x * c2 - d2.y * s2, d2.x * s2 + d2.y * c2);
      d2 = lnrm.xz; lnrm.xz = vec2(d2.x * c2 - d2.y * s2, d2.x * s2 + d2.y * c2);
    } else if (aAnim.x > 0.5) {     // 车轮:绕局部 z 轴心 (a,b) 按里程/半径滚动
      float ang = -along / max(aAnim.w, 0.05);
      float c2 = cos(ang), s2 = sin(ang);
      vec2 d2 = lp.xy - aAnim.yz;
      lp.xy = aAnim.yz + vec2(d2.x * c2 - d2.y * s2, d2.x * s2 + d2.y * c2);
      d2 = lnrm.xy; lnrm.xy = vec2(d2.x * c2 - d2.y * s2, d2.x * s2 + d2.y * c2);
    }
    vec3 p; vec3 n;
    if (uIsTurret > 0.5) {
      p = base + rotY(uTurretPivot, h) + rotY(lp, ty) + kick * rec;
      n = rotY(lnrm, ty);
    } else {
      p = base + rotY(lp, h) + kick * (rec * 0.35);
      n = rotY(lnrm, h);
    }
    // 发动机震动:怠速微颤 + 行驶加重(地面单位;无人机已有悬浮抖动)
    float spd = length(iCurr.xy - iPrev.xy) * 15.0;
    if (uAlt < 0.5) {
      p.y += sin(uNow * 33.0 + seed * 2.3) * (0.012 + 0.022 * clamp(spd * 0.125, 0.0, 1.0));
    }
    vNormal = n;
    vUv = uvL;
    vTile = aTile;
    vAccent = clamp(aPaint.r - 1.0, 0.0, 1.0);
    // 整数部分=team+kind*2(必须 floor:小数位载有种子+选中位,四舍五入会把队伍顶翻)
    int tk = int(floor(iMeta.x));
    int team = tk - 2 * (tk / 2); // 低位=队伍
    // 血量取整数部分(32 档,小数位是后坐量);压暗收敛——战损靠烟火表达
    float hp01 = floor(iMeta.y) / 31.0;
    float hpDarken = mix(0.62, 1.0, 0.25 + 0.75 * hp01);
    // 军事化涂装:车体=低饱和队伍底色(远观靠暖冷色调分辨),识别带=饱和队色大色块
    vec3 painted = mix(uBodyColors[team], uTeamColors[team], clamp(aPaint.r - 1.0, 0.0, 1.0));
    vec3 albedo = mix(vec3(0.34, 0.34, 0.35), painted, clamp(aPaint.r, 0.0, 1.0)) * aPaint.g;
    // 逐单位明度抖动(轻,种子稳定):打破均一感但不引入噪声/闪烁
    albedo *= 0.95 + 0.10 * fract(seed * 0.6180339887);
    vColor = albedo * hpDarken;
    vEmis = (uTeamColors[team] * 1.6 + vec3(0.5, 0.35, 0.25)) * aPaint.b; // 能量部件队色辉光
    vWorld = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// ---- 单位片元着色器(图集采样 + 自定义光照/阴影/云影/雾) ----
const UNIT_FRAG_GLSL = `
  uniform sampler2D uLightGrid;
  uniform sampler2D uShadowMap;
  uniform sampler2D uSkin;
  uniform mat4 uShadowMat;
  uniform float uShadowOn;
  uniform float uNow;
  uniform float uCloudA;
  varying vec3 vColor;
  varying vec3 vNormal;
  varying vec3 vWorld;
  varying vec3 vEmis;
  varying float vSel;
  varying vec2 vUv;
  varying vec4 vTile;
  varying float vAccent;
  ${SHADING_GLSL}
  ${CLOUD_SHADE_GLSL}
  void main() {
    vec3 n = normalize(vNormal);
    // 像素画图集:瓦片是中性浅灰"表面设计",×1.22 补回均值,涂装色透出;
    // 队色区纹理减淡到 38%(队色面板保持干净,细节由中性区承担)
    // 平铺采样:fract(局部重复坐标) 映回瓦片矩形(gutter 防 mip 渗色)
    vec3 skin = texture2D(uSkin, vTile.xy + fract(vUv) * vTile.zw).rgb * 1.22;
    skin = mix(skin, vec3(0.96), vAccent * 0.5);
    vec3 albedo = pow(vColor * skin, vec3(2.2));           // sRGB -> 线性
    vec3 L = normalize(vec3(0.5, 0.475, 0.3));             // 与场景太阳方向一致
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 H = normalize(L + V);
    float ndl = max(dot(n, L), 0.0);
    float sh = sampleUnitShadow(uShadowMap, uShadowMat, vWorld, uShadowOn);
    vec3 sunCol = vec3(1.0, 0.93, 0.80) * 2.0;             // 暖阳
    float spec = pow(max(dot(n, H), 0.0), 40.0) * 0.3 * (0.3 + 0.7 * ndl); // 金属高光(克制)
    float fres = pow(1.0 - max(dot(n, V), 0.0), 3.0);
    vec3 refl = skyEnv(reflect(-V, n));                    // 天穹环境反射(弱,涂装本色优先)
    vec3 dyn = texture2D(uLightGrid, vWorld.xz / vec2(${CONFIG.mapW}.0, ${CONFIG.mapH}.0)).rgb;
    // 顶面填充光:星际式"预打亮"——俯视角下车顶恒亮,单位从地形里跳出来
    vec3 topFill = vec3(0.34, 0.32, 0.29) * max(n.y, 0.0);
    vec3 col = albedo * (ambient3(n) + topFill + sunCol * ndl * sh)
             + sunCol * spec * sh
             + refl * (fres * 0.16 + 0.02)
             + (albedo * 0.8 + vec3(0.22)) * dyn
             + vEmis * 1.6
             + vec3(0.05, 0.38, 0.12) * vSel * (0.08 + 0.85 * fres); // 选中:绿色轮廓光(主标识是地面环,车身别盖队色)
    col *= mix(1.0, cloudShade(vWorld.xz, uNow), uCloudA); // 云影漂过
    col = acesTonemap(col);
    col = pow(col, vec3(1.0 / 2.2));                       // 线性 -> sRGB
    // 距离雾(常量须与 main.ts 的 scene.fog 同步)
    float fd = length(cameraPosition - vWorld) * 0.0007;
    col = mix(col, vec3(0.067, 0.082, 0.106), 1.0 - exp(-fd * fd));
    gl_FragColor = vec4(col, 1.0);
  }
`;

// ---- blob 假阴影顶点着色器(椭圆面片逐顶点贴地) ----
const BLOB_VERT_GLSL = `
  uniform float uAlpha;
  uniform vec2 uHalf;          // 椭圆半轴(归一化用)
  attribute vec4 iPrev;
  attribute vec4 iCurr;
  attribute vec2 iMeta;        // 小数位含选中标记(画选择环)
  varying vec2 vUvc;
  varying vec3 vWorld;
  varying float vSel;
  float lerpAngle(float a, float b, float t) {
    float d = mod(b - a + 3.14159265, 6.2831853) - 3.14159265;
    return a + d * t;
  }
  vec3 rotY(vec3 p, float h) {
    float c = cos(h), s = sin(h);
    return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  }
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    float h = lerpAngle(iPrev.z, iCurr.z, uAlpha);
    vec2 ground = mix(iPrev.xy, iCurr.xy, uAlpha);
    vSel = step(0.5, fract(iMeta.x));
    vec3 p = vec3(ground.x, 0.0, ground.y) + rotY(position, h);
    p.y = terrainH(p.xz) + 0.06; // 逐顶点贴地:阴影片在坡面上不穿地
    vUvc = position.xz / uHalf;
    vWorld = p;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// ---- blob 假阴影片元着色器(柔边椭圆 + 选择环) ----
const BLOB_FRAG_GLSL = `
  uniform float uShadowA;
  uniform vec2 uFocus;     // 相机焦点:近景换真实投影,blob 淡出避免双重阴影
  uniform float uFadeOn;
  varying vec2 vUvc;
  varying vec3 vWorld;
  varying float vSel;
  void main() {
    float r = length(vUvc);
    float a = (1.0 - smoothstep(0.45, 1.0, r)) * uShadowA;
    float fd = length(cameraPosition - vWorld) * 0.0007; // 与场景雾同步,远处阴影随雾淡出
    a *= mix(1.0, 0.18, uFadeOn * (1.0 - smoothstep(105.0, 150.0, distance(vWorld.xz, uFocus))));
    a *= exp(-fd * fd);
    // 星际式选择环:细绿环压在车体足迹内(密集阵列下不能比间距大,否则连成地毯)
    float ring = (smoothstep(0.40, 0.50, r) - smoothstep(0.56, 0.66, r)) * vSel;
    gl_FragColor = vec4(vec3(0.20, 0.95, 0.38) * ring, max(a, ring * 0.6));
  }
`;

// 每兵种渲染描述表(索引 = KIND):模型工厂、炮塔枢轴、blob 椭圆半轴/浓度、
// 远/近档实例容量、飞行高度、是否近景真实投影、后坐幅度(米)
const KIND_RENDER = [
  { // MBT 主战坦克
    hull: HULL_BUILDERS[KIND.MBT],
    turret: TURRET_BUILDERS[KIND.MBT],
    pivot: MUZZLE_OFFSETS[KIND.MBT],
    blob: [2.9, 2],
    blobA: 0.42,
    cap: CONFIG.maxUnits,
    alt: 0,
    nearCap: 4096,
    castShadow: true,
    recoil: 0.26,
  },
  { // GIANT 巨型坦克
    hull: HULL_BUILDERS[KIND.GIANT],
    turret: TURRET_BUILDERS[KIND.GIANT],
    pivot: MUZZLE_OFFSETS[KIND.GIANT],
    blob: [7, 4.6],
    blobA: 0.42,
    cap: 512,
    alt: 0,
    nearCap: 128,
    castShadow: true,
    recoil: 0.75,
  },
  { // SCOUT 侦察车
    hull: HULL_BUILDERS[KIND.SCOUT],
    turret: TURRET_BUILDERS[KIND.SCOUT],
    pivot: MUZZLE_OFFSETS[KIND.SCOUT],
    blob: [2.2, 1.5],
    blobA: 0.4,
    cap: (CONFIG.maxUnits * 0.18) | 0,
    alt: 0,
    nearCap: 1024,
    castShadow: true,
    recoil: 0.07,
  },
  { // MLRS 火箭炮车
    hull: HULL_BUILDERS[KIND.MLRS],
    turret: TURRET_BUILDERS[KIND.MLRS],
    pivot: MUZZLE_OFFSETS[KIND.MLRS],
    blob: [3, 2],
    blobA: 0.42,
    cap: (CONFIG.maxUnits * 0.05) | 0,
    alt: 0,
    nearCap: 320,
    castShadow: true,
    recoil: 0.14,
  },
  { // DESTROYER 磁轨歼击车
    hull: HULL_BUILDERS[KIND.DESTROYER],
    turret: TURRET_BUILDERS[KIND.DESTROYER],
    pivot: MUZZLE_OFFSETS[KIND.DESTROYER],
    blob: [3.1, 2],
    blobA: 0.42,
    cap: (CONFIG.maxUnits * 0.08) | 0,
    alt: 0,
    nearCap: 512,
    castShadow: true,
    recoil: 0.34,
  },
  { // DRONE 攻击无人机(无炮塔;pivot 用 MBT 值占位,与原码一致,uIsTurret 恒 0 不生效)
    hull: HULL_BUILDERS[KIND.DRONE],
    turret: null,
    pivot: MUZZLE_OFFSETS[KIND.MBT],
    blob: [1.6, 1.6],
    blobA: 0.22,
    cap: (CONFIG.maxUnits * 0.12) | 0,
    alt: 11,
    nearCap: 1024,
    castShadow: false,
    recoil: 0.05,
  },
];

// 近景半径(米):焦点该距离内的单位用高模 + 真实投影
const NEAR_RADIUS = 150;

// ---- 近景投影体顶点着色器(只在"单位影相机"渲染时摆出几何,否则挤到裁剪域外) ----
const CASTER_VERT_GLSL = `
  uniform float uAlpha;
  uniform float uCasterOn;  // 只为近景影相机投影,不污染全图障碍阴影贴图
  attribute vec4 iPrev;
  attribute vec4 iCurr;
  float lerpAngle(float a, float b, float t) {
    float d = mod(b - a + 3.14159265, 6.2831853) - 3.14159265;
    return a + d * t;
  }
  vec3 rotY(vec3 p, float h) {
    float c = cos(h), s = sin(h);
    return vec3(p.x * c - p.z * s, p.y, p.x * s + p.z * c);
  }
  ${TERRAIN_HEIGHT_GLSL}
  void main() {
    if (uCasterOn < 0.5) { gl_Position = vec4(0.0, 0.0, -10.0, 1.0); return; }
    float h = lerpAngle(iPrev.z, iCurr.z, uAlpha);
    vec2 g = mix(iPrev.xy, iCurr.xy, uAlpha);
    vec3 p = vec3(g.x, terrainH(g), g.y) + rotY(position, h);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

// 深度打包片元(供阴影贴图采样端 unpackShadowDepth 解包)
const CASTER_DEPTH_FRAG_GLSL = `
  #include <packing>
  void main() { gl_FragColor = packDepthToRGBA(gl_FragCoord.z); }
`;

export class FleetRenderer {
  buffers = [];          // 远档交错实例缓冲(按兵种)
  nearBufs = [];         // 近档交错实例缓冲(按兵种)
  geosByKind = [];       // 远档几何(车体/炮塔/blob),同步 instanceCount
  nearGeosByKind = [];   // 近档几何(车体/炮塔/blob/投影体)
  materials = [];        // 全部材质(uAlpha/uNow 统一驱动)
  unitMats = [];         // 单位材质(阴影/云影 uniform)
  blobMats = [];         // blob 阴影材质(焦点淡出)
  shadowCam = null;      // 单位影相机(onBeforeShadow 判定用)
  meshFar = [];
  meshNear = [];
  meshBlob = [];
  meshCaster = [];
  lastCounts = { far: 0, near: 0 };

  constructor(scene, flashMapTexture) {
    for (const def of KIND_RENDER) {
      // 每实例 10 float = 快照记录原样上传(SNAP_STRIDE)
      const makeBuffer = (cap) => {
        const buf = new InstancedInterleavedBuffer(new Float32Array(cap * 10), 10);
        buf.setUsage(DynamicDrawUsage);
        return buf;
      };
      const farBuf = makeBuffer(def.cap);
      const nearBuf = makeBuffer(def.nearCap);
      this.buffers.push(farBuf);
      this.nearBufs.push(nearBuf);
      const makeAttrs = (buf) => ({
        iPrev: new InterleavedBufferAttribute(buf, 4, 0),
        iCurr: new InterleavedBufferAttribute(buf, 4, 4),
        iMeta: new InterleavedBufferAttribute(buf, 2, 8),
      });
      const farAttrs = makeAttrs(farBuf);
      const nearAttrs = makeAttrs(nearBuf);
      const farGeos = [];
      const nearGeos = [];

      // 由模型工厂几何 + 实例属性拼一只实例化网格(isTurret: 0 车体 / 1 炮塔)
      const addUnitMesh = (srcGeom, isTurret, attrs, geoList) => {
        const geo = new InstancedBufferGeometry();
        geo.index = srcGeom.index;
        geo.setAttribute(`position`, srcGeom.getAttribute(`position`));
        geo.setAttribute(`normal`, srcGeom.getAttribute(`normal`));
        geo.setAttribute(`uv`, srcGeom.getAttribute(`uv`));
        geo.setAttribute(`aTile`, srcGeom.getAttribute(`aTile`));
        geo.setAttribute(`aAnim`, srcGeom.getAttribute(`aAnim`));
        geo.setAttribute(`aPaint`, srcGeom.getAttribute(`color`));
        geo.setAttribute(`iPrev`, attrs.iPrev);
        geo.setAttribute(`iCurr`, attrs.iCurr);
        geo.setAttribute(`iMeta`, attrs.iMeta);
        geo.instanceCount = 0;
        const mat = new ShaderMaterial({
          vertexShader: UNIT_VERT_GLSL,
          fragmentShader: UNIT_FRAG_GLSL,
          uniforms: {
            uAlpha: { value: 0 },
            uNow: { value: 0 },
            uIsTurret: { value: isTurret },
            uAlt: { value: def.alt },
            uRecoilK: { value: def.recoil },
            uTurretPivot: { value: def.pivot },
            uTeamColors: { value: [new Color(0xd8503a), new Color(0x4a90e4)] },
            uBodyColors: { value: [new Color(0x787c6e), new Color(0x787c6e)] },
            uLightGrid: { value: flashMapTexture },
            uShadowMap: { value: null },
            uShadowMat: { value: new Matrix4() },
            uShadowOn: { value: 0 },
            uSkin: { value: getHullAtlas() },
            uCloudA: { value: 1 },
          },
        });
        this.materials.push(mat);
        this.unitMats.push(mat);
        const mesh = new Mesh(geo, mat);
        mesh.frustumCulled = false;
        scene.add(mesh);
        (geoList === farGeos ? this.meshFar : this.meshNear).push(mesh);
        geoList.push(geo);
      };
      // 远档低模 + 近档高模各一套(hull(false)=低模, hull(true)=高模)
      addUnitMesh(def.hull(false), 0, farAttrs, farGeos);
      if (def.turret) addUnitMesh(def.turret(false), 1, farAttrs, farGeos);
      addUnitMesh(def.hull(true), 0, nearAttrs, nearGeos);
      if (def.turret) addUnitMesh(def.turret(true), 1, nearAttrs, nearGeos);

      // blob 椭圆假阴影(远近两档共用同一材质)
      const blobGeom = new PlaneGeometry(def.blob[0] * 2, def.blob[1] * 2)
        .rotateX(-Math.PI / 2)
        .translate(0, 0.03, 0);
      const blobMat = new ShaderMaterial({
        vertexShader: BLOB_VERT_GLSL,
        fragmentShader: BLOB_FRAG_GLSL,
        uniforms: {
          uAlpha: { value: 0 },
          uHalf: { value: new Vector2(def.blob[0], def.blob[1]) },
          uShadowA: { value: def.blobA },
          uFocus: { value: new Vector2(0, 0) },
          uFadeOn: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
      });
      this.materials.push(blobMat);
      this.blobMats.push(blobMat);
      const addBlobMesh = (attrs, geoList) => {
        const geo = new InstancedBufferGeometry();
        geo.index = blobGeom.index;
        geo.setAttribute(`position`, blobGeom.getAttribute(`position`));
        geo.setAttribute(`iPrev`, attrs.iPrev);
        geo.setAttribute(`iCurr`, attrs.iCurr);
        geo.setAttribute(`iMeta`, attrs.iMeta);
        geo.instanceCount = 0;
        const mesh = new Mesh(geo, blobMat);
        mesh.frustumCulled = false;
        scene.add(mesh);
        this.meshBlob.push(mesh);
        geoList.push(geo);
      };
      addBlobMesh(farAttrs, farGeos);
      addBlobMesh(nearAttrs, nearGeos);

      // 近景真实投影体:低模车体 + 近档实例缓冲,仅向"单位影相机"投影
      if (def.castShadow) {
        const casterGeo = new InstancedBufferGeometry();
        const hullLo = def.hull(false);
        casterGeo.index = hullLo.index;
        casterGeo.setAttribute(`position`, hullLo.getAttribute(`position`));
        casterGeo.setAttribute(`iPrev`, nearAttrs.iPrev);
        casterGeo.setAttribute(`iCurr`, nearAttrs.iCurr);
        casterGeo.instanceCount = 0;
        const depthMat = new ShaderMaterial({
          vertexShader: CASTER_VERT_GLSL,
          fragmentShader: CASTER_DEPTH_FRAG_GLSL,
          uniforms: { uAlpha: { value: 0 }, uCasterOn: { value: 0 } },
        });
        this.materials.push(depthMat);
        // 本体在主 pass 完全不可见(不写色不写深),只借 castShadow 进影 pass
        const caster = new Mesh(casterGeo, new MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
        caster.castShadow = true;
        caster.frustumCulled = false;
        caster.renderOrder = -10;
        caster.customDepthMaterial = depthMat;
        this.meshCaster.push(caster);
        caster.onBeforeShadow = (renderer, sceneArg, camera, shadowCamera) => {
          depthMat.uniforms.uCasterOn.value = +(shadowCamera === this.shadowCam);
        };
        scene.add(caster);
        nearGeos.push(casterGeo);
      }

      this.geosByKind.push(farGeos);
      this.nearGeosByKind.push(nearGeos);
    }
  }

  // 把当前帧快照分拣进远/近档实例缓冲。
  // snap: 快照 Float32Array(stride 10);count: 单位总数;
  // (focusX, focusZ): 相机焦点;clipQuad: 可选视锥地面四边形 [x0,z0,...,x3,z3]
  uploadSnapshot(snap, count, focusX, focusZ, clipQuad) {
    const kinds = KIND_RENDER.length;
    const farCounts = Array(kinds).fill(0);
    const nearCounts = Array(kinds).fill(0);
    const nearRadiusSq = NEAR_RADIUS * NEAR_RADIUS;
    // 视锥四边形 4 条边:方向(d*x,d*z)、起点(p*x,p*z)、余量 m*(= 35m × 边长,叉积同尺度)
    let d0x = 0, d0z = 0, d1x = 0, d1z = 0, d2x = 0, d2z = 0, d3x = 0, d3z = 0,
      p0x = 0, p0z = 0, p1x = 0, p1z = 0, p2x = 0, p2z = 0, p3x = 0, p3z = 0,
      m0 = 0, m1 = 0, m2 = 0, m3 = 0,
      clipOn = false;
    if (clipQuad && clipQuad.length >= 8) {
      const q = clipQuad;
      // 鞋带公式定绕向,把 4 条边的"内侧"统一成同一符号
      let area2 = 0;
      for (let k = 0; k < 4; k++) {
        const x0 = q[k * 2],
          z0 = q[k * 2 + 1],
          x1 = q[((k + 1) & 3) * 2],
          z1 = q[((k + 1) & 3) * 2 + 1];
        area2 += x0 * z1 - x1 * z0;
      }
      const sign = area2 >= 0 ? 1 : -1;
      const edge = (k) => {
        const x0 = q[k * 2],
          z0 = q[k * 2 + 1],
          x1 = q[((k + 1) & 3) * 2],
          z1 = q[((k + 1) & 3) * 2 + 1];
        return [(x1 - x0) * sign, (z1 - z0) * sign, x0, z0, 35 * Math.hypot(x1 - x0, z1 - z0)];
      };
      [d0x, d0z, p0x, p0z, m0] = edge(0);
      [d1x, d1z, p1x, p1z, m1] = edge(1);
      [d2x, d2z, p2x, p2z, m2] = edge(2);
      [d3x, d3z, p3x, p3z, m3] = edge(3);
      clipOn = true;
    }
    for (let i = 0; i < count; i++) {
      const base = i * 10;
      const x = snap[base + 4];
      const z = snap[base + 5];
      // 任一边外侧(叉积 < -余量)即视锥外,跳过
      if (
        clipOn &&
        (d0x * (z - p0z) - d0z * (x - p0x) < -m0 ||
          d1x * (z - p1z) - d1z * (x - p1x) < -m1 ||
          d2x * (z - p2z) - d2z * (x - p2x) < -m2 ||
          d3x * (z - p3z) - d3z * (x - p3x) < -m3)
      )
        continue;
      // meta 整数部分 = team + kind*2 → 右移 1 位得兵种
      let kind = (snap[base + 8] / 2) | 0;
      if (kind >= kinds) kind = 0;
      const record = snap.subarray(base, base + 10);
      const fx = x - focusX,
        fz = z - focusZ;
      if (fx * fx + fz * fz < nearRadiusSq && nearCounts[kind] < KIND_RENDER[kind].nearCap) {
        this.nearBufs[kind].array.set(record, nearCounts[kind] * 10);
        nearCounts[kind]++;
      } else if (farCounts[kind] < KIND_RENDER[kind].cap) {
        this.buffers[kind].array.set(record, farCounts[kind] * 10);
        farCounts[kind]++;
      }
    }
    for (let k = 0; k < kinds; k++) {
      const apply = (buf, n, geos) => {
        buf.clearUpdateRanges();
        buf.addUpdateRange(0, n * 10);
        buf.needsUpdate = true;
        for (const geo of geos) geo.instanceCount = n;
      };
      apply(this.buffers[k], farCounts[k], this.geosByKind[k]);
      apply(this.nearBufs[k], nearCounts[k], this.nearGeosByKind[k]);
    }
    this.lastCounts.far = farCounts.reduce((a, b) => a + b, 0);
    this.lastCounts.near = nearCounts.reduce((a, b) => a + b, 0);
  }

  // 每帧:插值因子(两快照间 0..1)与渲染时钟
  setFrame(alpha, now) {
    for (const mat of this.materials) {
      mat.uniforms.uAlpha.value = alpha;
      if (mat.uniforms.uNow) mat.uniforms.uNow.value = now;
    }
  }

  // 云影强度(0 关)
  setCloud(alpha) {
    for (const mat of this.unitMats) mat.uniforms.uCloudA.value = alpha;
  }

  // 接入/关闭单位阴影:贴图 + 世界→影图矩阵 + 影相机;焦点用于 blob 淡出
  setShadow(map, matrix, camera, focusX, focusZ) {
    this.shadowCam = camera;
    const on = +!!map;
    for (const mat of this.unitMats) {
      mat.uniforms.uShadowMap.value = map;
      mat.uniforms.uShadowMat.value = matrix;
      mat.uniforms.uShadowOn.value = on;
    }
    for (const mat of this.blobMats) {
      mat.uniforms.uFocus.value.set(focusX, focusZ);
      mat.uniforms.uFadeOn.value = on;
    }
  }
}

// 预览(检阅)模式主模块:独立场景里逐一检阅六个兵种,带演示驾驶循环(行驶 → 炮塔回旋 → 开火)。
// 由混淆模块 18(信息面板/快照历史/演示循环)与 19(场景/灯光/检阅台/UI/主循环)合并而成,
// 两段原本经 bundle 顶层变量共享状态,此处收敛为本模块的模块级变量。
// 入口 src/main.js 在 location.hash === '#preview' 时动态 import 并调用 startPreview()。

import {
  WebGLRenderer,
  Scene,
  Color,
  FogExp2,
  PerspectiveCamera,
  DirectionalLight,
  HemisphereLight,
  PlaneGeometry,
  CanvasTexture,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  BufferGeometry,
  Float32BufferAttribute,
  InstancedMesh,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
  Euler,
  RepeatWrapping,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  PCFShadowMap,
  DoubleSide,
} from 'three';
import { CONFIG, KIND_STATS } from '../core/config.js';
import { terrainHeight } from '../world/terrain.js';
import { buildSky } from '../world/sky.js';
import { HULL_BUILDERS, TURRET_BUILDERS } from '../models/index.js';
import { FleetRenderer } from '../render/fleet-renderer.js';
import { GroundFlashMap } from '../render/ground-flash-map.js';
import { ParticlePool } from '../render/fx/particles.js';
import { BeamPool } from '../render/fx/beams.js';
import { FlashPool, ShockwavePool } from '../render/fx/flashes.js';

// ===================== 静态数据与模块级共享状态 =====================

// 六兵种介绍卡(原 Q_)
const KIND_CARDS = [
  { kind: 0, name: `主战坦克`, desc: `中坚战线 · 站桩对射` },
  { kind: 1, name: `巨型坦克`, desc: `超重型压阵 · 70m 巨炮 14m AOE` },
  { kind: 2, name: `侦察车`, desc: `高速先锋 · 打了就跑` },
  { kind: 3, name: `火箭炮车`, desc: `六连齐射 · 小 AOE 覆盖` },
  { kind: 4, name: `磁轨歼击车`, desc: `远程重击 · 敌近倒车保距` },
  { kind: 5, name: `攻击无人机`, desc: `飞行掠袭 · 越障俯射` },
];

const CENTER_X = CONFIG.mapW / 2; // 检阅台位于地图中心(原 $_)
const CENTER_Z = CONFIG.mapH / 2; // 原 ev
const groundY = (x, z) => terrainHeight(x, z); // 地形采样(原 tv)
const TICK_MS = 1e3 / 15; // 演示模拟 tick 间隔,毫秒(原 Ev)

// —— 渲染对象(原 nv/rv/iv/av/ov/sv/cv/lv/uv/dv/pv) ——
let renderer, scene, camera;
let flashMap; // GroundFlashMap:炮火地面光斑
let fleet; // FleetRenderer:实例化坦克渲染(单车检阅)
let glowParticles, smokeParticles; // 加性发光粒子 / 烟尘粒子
let beamPool, flashPool, shockwavePool;
let shadowLight; // 投影主光(填充光 fillLight 仅在初始化中使用)

// —— 检阅状态(原 hv/gv/_v/vv) ——
let triCounts; // 各兵种高/低模三角面数表(原 hv)
let currentKind = 0; // 当前检阅兵种(原 gv)
let currentTeam = 0; // 红/蓝涂装(原 _v)
let useHiModel = true; // 高模/低模开关(原 vv)

// —— 演示单车运动状态(原 yv/bv/xv/Sv/Cv/wv/Tv/Dv/Ov) ——
let hullYaw = 0; // 车体朝向
let turretYaw = 0; // 炮塔朝向
let firePulse = 0; // 开火亮度脉冲(0..1,逐 tick 衰减)
let unitX = CENTER_X;
let unitZ = CENTER_Z;
let snapBuf; // Float32Array(10):快照双缓冲 [0..3]上帧 [4..7]本帧 x/z/车体角/炮塔角,[8]meta,[9]状态
let lastTickMs = 0; // 上一 tick 时间(原 Tv)
let demoClock = 0; // 演示循环时钟,秒(原 Dv)
let fireCooldown = 0; // 开火冷却,秒(原 Ov)
let camDist = 22; // 相机距离(原 jv,resetView 按兵种重设)

// ===================== 快照历史 / 视角重置(原 18 号) =====================

// 原 q_:把本帧单车状态推入快照双缓冲(供渲染端在两 tick 间插值),并写入 meta。
function pushSnapshotFrame() {
  snapBuf[0] = snapBuf[4];
  snapBuf[1] = snapBuf[5];
  snapBuf[2] = snapBuf[6];
  snapBuf[3] = snapBuf[7];
  snapBuf[4] = unitX;
  snapBuf[5] = unitZ;
  snapBuf[6] = hullYaw;
  snapBuf[7] = turretYaw;
  snapBuf[8] = currentTeam + currentKind * 2 + 17 / 256; // meta:队伍 + 兵种*2 + 血量分数
  snapBuf[9] = 31 + Math.min(firePulse, 0.96); // 状态:满履带速 + 炮口光脉冲
}

// 原 J_:切换兵种/进场时重置单车位姿与演示时钟,并按兵种设定相机距离。
function resetView() {
  hullYaw = Math.PI / 4;
  turretYaw = hullYaw;
  firePulse = 0;
  demoClock = 0;
  fireCooldown = 0;
  unitX = CENTER_X;
  unitZ = CENTER_Z;
  snapBuf[4] = unitX;
  snapBuf[5] = unitZ;
  snapBuf[6] = hullYaw;
  snapBuf[7] = turretYaw;
  pushSnapshotFrame();
  camDist = currentKind === 1 ? 36 : currentKind === 5 ? 26 : 22;
}

// 原 Y_:按当前兵种生成一次开火特效(炮口光、曳光弹、落点爆炸/烟/冲击波/地面光斑)。
function fireDemoShot(nowMs) {
  const stats = KIND_STATS[currentKind];
  firePulse = 1;
  const muzzleY = currentKind === 1 ? 3.4 : currentKind === 5 ? 0 : 1.6; // 炮口离地高度
  const mx = unitX + Math.cos(turretYaw) * stats.muzzle; // 炮口
  const mz = unitZ + Math.sin(turretYaw) * stats.muzzle;
  const tx = unitX + Math.cos(turretYaw) * 46; // 落点(固定 46m 外)
  const tz = unitZ + Math.sin(turretYaw) * 46;
  const flight = 46 / stats.projSpeed; // 弹道飞行时间
  const t = nowMs / 1e3;
  if (currentKind === 1) {
    // 巨型坦克:巨炮 + 大 AOE,落点周围碎屑四溅
    glowParticles.spawn(mx, muzzleY, mz, t, 0, 1.2, 0, 1, 6);
    glowParticles.spawn(mx, 3, mz, t, (tx - mx) / flight, -2 / flight + 1.5 * flight, (tz - mz) / flight, 4, 2.4, flight);
    flashPool.spawn(mx, mz, t, 9, 0);
    for (let i = 0; i < 5; i++) {
      const ox = (Math.random() - 0.5) * 9;
      const oz = (Math.random() - 0.5) * 9;
      glowParticles.spawn(tx + ox, 1, tz + oz, t + flight + i * 0.045, ox * 0.8, 4 + Math.random() * 5, oz * 0.8, 2, 3.4);
    }
    smokeParticles.spawn(tx, 1.6, tz, t + flight + 0.08, 0, 2.6, 0, 3, 5.5);
    flashPool.spawn(tx, tz, t + flight, 19, 2);
    flashPool.spawn(tx, tz, t + flight + 0.05, 12, 1);
    shockwavePool.spawn(tx, tz, t + flight, 8.5);
    flashMap.spawn(mx, mz, t, 0.3, 24, 2.2);
    flashMap.spawn(tx, tz, t + flight, 0.65, 32, 3);
  } else if (currentKind === 3) {
    // 火箭炮车:六连齐射,落点随机散布
    for (let i = 0; i < 6; i++) {
      const hx = tx + (Math.random() - 0.5) * 10;
      const hz = tz + (Math.random() - 0.5) * 10;
      const hitAt = flight + i * 0.2;
      glowParticles.spawn(mx, 2.2, mz, t + i * 0.2, 0, 0.6, 0, 1, 2.2);
      glowParticles.spawn(mx, 2, mz, t + i * 0.2, (hx - mx) / flight, -1 / flight + 1.5 * flight, (hz - mz) / flight, 4, 1.3, flight);
      glowParticles.spawn(hx, 0.9, hz, t + hitAt, 0, 3, 0, 2, 2.4);
      smokeParticles.spawn(hx, 1.2, hz, t + hitAt + 0.05, 0, 2, 0, 3, 2.4);
      flashPool.spawn(hx, hz, t + hitAt, 6, 0);
      shockwavePool.spawn(hx, hz, t + hitAt, 4);
      flashMap.spawn(hx, hz, t + hitAt, 0.3, 13, 1.1);
    }
  } else if (currentKind === 4) {
    // 磁轨歼击车:平直高速弹道,落点冷色光斑
    glowParticles.spawn(mx, 1.9, mz, t, 0, 0.3, 0, 1, 2);
    glowParticles.spawn(mx, 1.8, mz, t, (tx - mx) / flight, 0, (tz - mz) / flight, 5, 1.5, flight);
    glowParticles.spawn(tx, 1.5, tz, t + flight, 0, 1.5, 0, 2, 1.6);
    flashMap.spawn(tx, tz, t + flight, 0.2, 9, 0.8, 0.55, 0.85, 1);
  } else if (currentKind === 5) {
    // 攻击无人机:自机身(11m 高)俯射
    glowParticles.spawn(unitX, 10.6, unitZ, t, 0, 0, 0, 1, 1.4);
    glowParticles.spawn(unitX, 10.4, unitZ, t, (tx - unitX) / flight, -9.200000000000001 / flight, (tz - unitZ) / flight, 5, 1.1, flight);
    glowParticles.spawn(tx, 1, tz, t + flight, 0, 1.8, 0, 2, 1.3);
    flashMap.spawn(tx, tz, t + flight, 0.26, 10, 0.8);
  } else {
    // 主战坦克 / 侦察车:直射 + 光束曳线
    glowParticles.spawn(mx, muzzleY, mz, t, 0, 0.5, 0, 1, currentKind === 2 ? 0.9 : 1.6);
    glowParticles.spawn(tx, 0.8, tz, t + flight, 0, 2.5, 0, 2, 1.8);
    smokeParticles.spawn(tx, 1, tz, t + flight, 0, 1.8, 0, 3, 1.2);
    beamPool.spawn(mx, mz, tx, tz, t, flight);
    flashPool.spawn(tx, tz, t + flight, 5, 0);
    flashPool.spawn(mx, mz, t, 3.5, 0);
    flashMap.spawn(mx, mz, t, 0.16, 9, 0.55);
    flashMap.spawn(tx, tz, t + flight, 0.26, 10, 0.8);
  }
}

// 原 X_:演示驾驶循环,每 tick(1/15s)推进一次。
// 22 秒一轮:0~7s 绕场行驶(3.4s 起原地转向半圈),7~12s 炮塔左右回旋,12~22s 周期开火。
function runDemoDrive(nowMs) {
  const stats = KIND_STATS[currentKind];
  const dt = 1 / 15;
  demoClock += dt;
  if (firePulse > 0) {
    firePulse *= 0.55;
    if (firePulse < 0.04) firePulse = 0;
  }
  const phase = demoClock % 22;
  if (phase < 7) {
    if (phase > 3.4 && phase < 3.4 + Math.PI / stats.turn) {
      hullYaw += stats.turn * dt; // 原地转向展示
    } else {
      unitX += Math.cos(hullYaw) * stats.speed * 0.55 * dt;
      unitZ += Math.sin(hullYaw) * stats.speed * 0.55 * dt;
    }
    // 炮塔向车头回正
    const diff = ((hullYaw - turretYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    turretYaw += Math.sign(diff) * Math.min(Math.abs(diff), stats.turretRate * dt);
    // 限制在检阅台中心 26m 内,越界则拉回并强制转弯
    const dx = unitX - CENTER_X;
    const dz = unitZ - CENTER_Z;
    const dist = Math.hypot(dx, dz);
    if (dist > 26) {
      unitX = CENTER_X + (dx / dist) * 26;
      unitZ = CENTER_Z + (dz / dist) * 26;
      hullYaw += (Math.PI / 2) * dt * 3;
    }
  } else if (phase < 12) {
    // 炮塔左右回旋扫视
    const diff = ((hullYaw + Math.sin((phase - 7) * 1.1) * 1.75 - turretYaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    turretYaw += Math.sign(diff) * Math.min(Math.abs(diff), stats.turretRate * dt);
  } else {
    fireCooldown -= dt;
    if (fireCooldown <= 0) {
      fireDemoShot(nowMs);
      fireCooldown = currentKind === 1 ? 4 : currentKind === 3 ? 4.5 : stats.cooldown / 15;
    }
  }
  pushSnapshotFrame();
  // 高模开关:把"战场焦点"挪到 1 万米外即可强制全员低模
  fleet.uploadSnapshot(snapBuf, 1, useHiModel ? CENTER_X : CENTER_X + 1e4, CENTER_Z);
  lastTickMs = nowMs;
}

// ===================== 信息面板(原 18 号 Z_) =====================

function renderInfoPanel() {
  const stats = KIND_STATS[currentKind];
  const card = KIND_CARDS.find((c) => c.kind === currentKind);
  document.getElementById(`pv-info`).innerHTML = `
    <h3>${card.name}</h3>
    <div class="d">${card.desc}</div>
    <table>
      <tr><td>血量</td><td>${stats.hp}</td><td>速度</td><td>${stats.speed} m/s</td></tr>
      <tr><td>射程</td><td>${stats.range} m</td><td>伤害</td><td>${stats.damage}${stats.aoe ? ` (AOE ${stats.aoe}m)` : ``}</td></tr>
      <tr><td>冷却</td><td>${(stats.cooldown / 15).toFixed(1)} s</td><td>弹速</td><td>${stats.projSpeed} m/s</td></tr>
      <tr><td>车身转速</td><td>${stats.turn} rad/s</td><td>炮塔转速</td><td>${stats.turretRate} rad/s</td></tr>
      <tr><td>当前模型</td><td style="color:${useHiModel ? `#8fd48f` : `#d4b06a`}">${useHiModel ? `近景高模` : `远景简模`}</td>
        <td>面数</td><td>${useHiModel ? triCounts[currentKind].hi : triCounts[currentKind].lo} tris</td></tr>
    </table>
    <div class="d" style="margin-top:6px">高模:战场焦点 150m 内 · 简模:其余全军(LOD 两档)</div>`;
}

// ===================== 入口(原 19 号 Iv 初始化) =====================

export function startPreview() {
  // ---------- 场景搭建:渲染器 / 场景 / 相机 / 天空 / 灯光 ----------
  renderer = new WebGLRenderer({ antialias: true, powerPreference: `high-performance` });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.55;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setSize(innerWidth, innerHeight);
  document.getElementById(`app`).appendChild(renderer.domElement);

  scene = new Scene();
  scene.background = new Color(1119515); // 0x11151b 暗夜蓝
  scene.fog = new FogExp2(1119515, 7e-4);

  camera = new PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 6e3);
  addEventListener(`resize`, () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  buildSky(scene);

  flashMap = new GroundFlashMap();
  fleet = new FleetRenderer(scene, flashMap.texture);
  fleet.setCloud(0); // 检阅模式无云影
  glowParticles = new ParticlePool(scene, 8192, true);
  smokeParticles = new ParticlePool(scene, 8192, false);
  beamPool = new BeamPool(scene, 2048);
  flashPool = new FlashPool(scene, 2048);
  shockwavePool = new ShockwavePool(scene, 512);

  // 暖阳填充光(无阴影)+ 天光半球
  const fillLight = new DirectionalLight(16772815, 1.65); // 0xffeecf
  fillLight.position.set(CENTER_X + 250, 237.5, CENTER_Z + 150);
  fillLight.target.position.set(CENTER_X, 0, CENTER_Z);
  scene.add(fillLight, fillLight.target, new HemisphereLight(10465474, 3816755, 0.6)); // 0x9fb0c2 / 0x3a3d33
  // 投影主光:80m 见方正交阴影盒,只罩住检阅台
  shadowLight = new DirectionalLight(16772815, 0.45);
  shadowLight.castShadow = true;
  shadowLight.shadow.mapSize.set(2048, 2048);
  const shadowCam = shadowLight.shadow.camera;
  shadowCam.left = -80;
  shadowCam.right = 80;
  shadowCam.top = 80;
  shadowCam.bottom = -80;
  shadowCam.near = 1;
  shadowCam.far = 900;
  shadowCam.updateProjectionMatrix();
  shadowLight.shadow.bias = -0.0012;
  shadowLight.position.set(CENTER_X + 250, 237.5, CENTER_Z + 150);
  shadowLight.target.position.set(CENTER_X, 0, CENTER_Z);
  scene.add(shadowLight, shadowLight.target);

  // ---------- 检阅台:贴地草皮 + 程序化草地纹理 + 草丛/岩石点缀 ----------
  {
    const groundGeom = new PlaneGeometry(360, 360, 56, 56).rotateX(-Math.PI / 2);
    const pos = groundGeom.getAttribute(`position`);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, groundY(CENTER_X + x, CENTER_Z + z) + 0.02); // 贴合地形,抬高 2cm 防 z-fight
    }
    groundGeom.computeVertexNormals();

    // 1024² 程序化草地画布(固定 LCG 种子 4242,逐帧确定)
    const canvas = document.createElement(`canvas`);
    canvas.width = canvas.height = 1024;
    const ctx = canvas.getContext(`2d`);
    let lcg = 4242;
    const rand = () => (lcg = (lcg * 1103515245 + 12345) & 2147483647) / 2147483647;
    ctx.fillStyle = `#49582f`;
    ctx.fillRect(0, 0, 1024, 1024);
    // 深浅色斑
    for (let i = 0; i < 900; i++) {
      const radius = 6 + rand() * 46;
      ctx.fillStyle =
        rand() < 0.5 ? `rgba(52, 66, 34, ${0.12 + rand() * 0.2})` : `rgba(108, 124, 66, ${0.1 + rand() * 0.16})`;
      ctx.beginPath();
      ctx.ellipse(rand() * 1024, rand() * 1024, radius, radius * (0.4 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    // 草茎短划
    for (let i = 0; i < 2600; i++) {
      const x = rand() * 1024;
      const y = rand() * 1024;
      ctx.strokeStyle = `rgba(${(120 + rand() * 50) | 0}, ${(140 + rand() * 40) | 0}, ${(70 + rand() * 30) | 0}, ${0.15 + rand() * 0.2})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (rand() - 0.5) * 5, y - 2 - rand() * 5);
      ctx.stroke();
    }
    // 整体噪点
    const img = ctx.getImageData(0, 0, 1024, 1024);
    const data = img.data;
    for (let i = 0; i < data.length; i += 4) {
      const noise = (rand() - 0.5) * 14;
      data[i] += noise;
      data[i + 1] += noise;
      data[i + 2] += noise;
    }
    ctx.putImageData(img, 0, 0);

    const grassTex = new CanvasTexture(canvas);
    grassTex.colorSpace = SRGBColorSpace;
    grassTex.wrapS = grassTex.wrapT = RepeatWrapping;
    grassTex.repeat.set(3, 3);
    grassTex.anisotropy = 4;

    const ground = new Mesh(groundGeom, new MeshLambertMaterial({ map: grassTex }));
    ground.position.set(CENTER_X, 0, CENTER_Z);
    ground.receiveShadow = true;
    scene.add(ground);

    // 单簇草:5 片三角叶,环形展开
    const verts = [];
    const cols = [];
    for (let i = 0; i < 5; i++) {
      const ang = (i / 5) * Math.PI * 2 + i * 1.7;
      const cx = Math.cos(ang);
      const sz = Math.sin(ang);
      const halfW = 0.07;
      const h = 0.5 + (0.3 * ((i * 7919) % 97)) / 97;
      verts.push(
        cx * 0.1 - sz * halfW, 0, sz * 0.1 + cx * halfW,
        cx * 0.1 + sz * halfW, 0, sz * 0.1 - cx * halfW,
        cx * 0.42, h, sz * 0.42,
      );
      cols.push(0.16, 0.18, 0.08, 0.16, 0.18, 0.08, 0.42, 0.44, 0.18);
    }
    const bladeGeom = new BufferGeometry();
    bladeGeom.setAttribute(`position`, new Float32BufferAttribute(verts, 3));
    bladeGeom.setAttribute(`color`, new Float32BufferAttribute(cols, 3));
    bladeGeom.computeVertexNormals();

    const tufts = new InstancedMesh(bladeGeom, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }), 240);
    const rocks = new InstancedMesh(
      new IcosahedronGeometry(1, 0),
      new MeshStandardMaterial({ color: 6183504, roughness: 1, flatShading: true }), // 0x5e5a50
      40,
    );
    const mat = new Matrix4();
    const quat = new Quaternion();
    const scl = new Vector3();
    // 草丛/岩石散布沿用同一 LCG 序列(与纹理绘制连续,保证可复现)
    for (let i = 0; i < 240; i++) {
      const ang = rand() * Math.PI * 2;
      const dist = 8 + rand() * 150;
      const x = CENTER_X + Math.cos(ang) * dist;
      const z = CENTER_Z + Math.sin(ang) * dist;
      const s = 0.8 + rand() * 1.3;
      quat.setFromEuler(new Euler(0, rand() * 6.28, 0));
      scl.set(s, s, s);
      mat.compose(new Vector3(x, groundY(x, z), z), quat, scl);
      tufts.setMatrixAt(i, mat);
      if (i < 40) {
        const rs = 0.2 + rand() * 0.5;
        scl.set(rs, rs * 0.7, rs);
        mat.compose(new Vector3(x + 1.5, groundY(x + 1.5, z) + rs * 0.2, z), quat, scl);
        rocks.setMatrixAt(i, mat);
      }
    }
    tufts.instanceMatrix.needsUpdate = true;
    rocks.instanceMatrix.needsUpdate = true;
    rocks.receiveShadow = true;
    scene.add(tufts, rocks);
  }

  // ---------- 面数表与演示状态初始化 ----------
  // 各兵种高/低模三角数:车体 + 炮塔(无人机无炮塔)
  triCounts = (() => {
    const tris = (g) => ((g.index ? g.index.count : g.getAttribute(`position`).count) / 3) | 0;
    const pair = (hull, turret) => ({
      hi: tris(hull(true)) + (turret ? tris(turret(true)) : 0),
      lo: tris(hull(false)) + (turret ? tris(turret(false)) : 0),
    });
    return HULL_BUILDERS.map((hull, k) => pair(hull, TURRET_BUILDERS[k]));
  })();
  currentKind = 0;
  currentTeam = 0;
  useHiModel = true;
  hullYaw = 0;
  turretYaw = 0;
  firePulse = 0;
  unitX = CENTER_X;
  unitZ = CENTER_Z;
  snapBuf = new Float32Array(10);
  lastTickMs = performance.now();
  demoClock = 0;
  fireCooldown = 0;
  let camYaw = 0.8; // 原 kv
  let camPitch = 0.42; // 原 Av
  camDist = 22;
  let lastInputMs = 0; // 最近一次交互时刻(原 Mv,3 秒无操作后自动环绕)

  // ---------- 相机轨道交互:拖拽旋转 / 滚轮缩放 ----------
  {
    const el = renderer.domElement;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    el.addEventListener(`pointerdown`, (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      lastInputMs = performance.now();
    });
    addEventListener(`pointerup`, () => {
      dragging = false;
    });
    addEventListener(`pointermove`, (e) => {
      if (!dragging) return;
      camYaw -= (e.clientX - lastX) * 0.006;
      camPitch = Math.min(Math.max(camPitch - (e.clientY - lastY) * 0.004, 0.08), 1.35);
      lastX = e.clientX;
      lastY = e.clientY;
      lastInputMs = performance.now();
    });
    el.addEventListener(
      `wheel`,
      (e) => {
        camDist = Math.min(Math.max(camDist * (1 + Math.sign(e.deltaY) * 0.1), 8), 90);
        lastInputMs = performance.now();
      },
      { passive: true },
    );
  }

  // ---------- 预览 UI:兵种列表 / 红蓝涂装 / 高低模 / 信息面板 ----------
  const ui = document.createElement(`div`);
  ui.id = `pv-ui`;
  ui.innerHTML = `
  <style>
    #pv-ui { position: fixed; inset: 0; pointer-events: none; z-index: 10;
      font: 12px/1.5 ui-monospace, Menlo, monospace; color: #cfd8e3; }
    #pv-ui .panel { background: rgba(10,14,20,.78); border: 1px solid #2a3442; border-radius: 8px;
      padding: 10px 12px; pointer-events: auto; }
    #pv-list { position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
      display: flex; flex-direction: column; gap: 6px; pointer-events: auto; }
    #pv-list button { background: #1b2430; color: #cfd8e3; border: 1px solid #2a3442; border-radius: 6px;
      padding: 8px 14px; cursor: pointer; font: inherit; text-align: left; min-width: 120px; }
    #pv-list button.on { background: #2f4a6b; border-color: #4da3ff; }
    #pv-info { position: absolute; right: 14px; bottom: 14px; min-width: 220px; }
    #pv-info h3 { margin: 0 0 4px; font-size: 15px; color: #e8eef6; }
    #pv-info .d { opacity: .65; margin-bottom: 8px; }
    #pv-info td { padding: 1px 10px 1px 0; opacity: .85; }
    #pv-top { position: absolute; top: 14px; left: 14px; display: flex; gap: 8px; }
    #pv-top button { background: #1b2430; color: #cfd8e3; border: 1px solid #2a3442; border-radius: 6px;
      padding: 6px 12px; cursor: pointer; font: inherit; }
    #pv-team button.on, #pv-lod button.on { background: #2f4a6b; }
    #pv-hint { position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
      opacity: .55; pointer-events: none; }
  </style>
  <div id="pv-top">
    <button id="pv-back" class="panel">← 返回主菜单</button>
    <span id="pv-team" class="panel">
      <button data-t="0" class="on" style="color:#ff5a52">红军</button>
      <button data-t="1" style="color:#4da3ff">蓝军</button>
    </span>
    <span id="pv-lod" class="panel">
      <button data-l="1" class="on">高模</button>
      <button data-l="0">低模</button>
    </span>
  </div>
  <div id="pv-list"></div>
  <div id="pv-info" class="panel"></div>
  <div id="pv-hint">拖拽旋转 · 滚轮缩放 · 演示循环:行驶 → 炮塔回旋 → 开火</div>
`;
  document.body.appendChild(ui);
  document.getElementById(`pv-back`).addEventListener(`click`, () => {
    location.hash = ``;
    location.reload();
  });
  const list = document.getElementById(`pv-list`);
  KIND_CARDS.forEach((card, idx) => {
    const btn = document.createElement(`button`);
    btn.textContent = card.name;
    if (idx === 0) btn.classList.add(`on`);
    btn.addEventListener(`click`, () => {
      list.querySelectorAll(`button`).forEach((b) => b.classList.remove(`on`));
      btn.classList.add(`on`);
      currentKind = card.kind;
      resetView();
      renderInfoPanel();
    });
    list.appendChild(btn);
  });
  document.querySelectorAll(`#pv-team button`).forEach((btn) =>
    btn.addEventListener(`click`, () => {
      document.querySelectorAll(`#pv-team button`).forEach((b) => b.classList.remove(`on`));
      btn.classList.add(`on`);
      currentTeam = Number(btn.dataset.t);
      pushSnapshotFrame(); // 立即换装,不等下一 tick
    }),
  );
  document.querySelectorAll(`#pv-lod button`).forEach((btn) =>
    btn.addEventListener(`click`, () => {
      document.querySelectorAll(`#pv-lod button`).forEach((b) => b.classList.remove(`on`));
      btn.classList.add(`on`);
      useHiModel = btn.dataset.l === `1`;
      renderInfoPanel();
    }),
  );
  renderInfoPanel();
  resetView();

  // 隐藏战斗模式残留的 HUD 元素
  for (const id of [`hud`, `banner`, `selbox`]) {
    const el = document.getElementById(id);
    if (el) el.style.display = `none`;
  }

  // ---------- 主循环:15Hz 演示 tick + 逐帧插值渲染 ----------
  let lastFrameMs = performance.now(); // 原 Fv
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const frameDt = Math.min((now - lastFrameMs) / 1e3, 0.05);
    lastFrameMs = now;
    if (now - lastTickMs >= TICK_MS) runDemoDrive(now);
    const alpha = Math.min((now - lastTickMs) / TICK_MS, 1); // tick 间插值系数
    fleet.setFrame(alpha, now / 1e3);
    fleet.setShadow(
      shadowLight.shadow.map ? shadowLight.shadow.map.texture : null,
      shadowLight.shadow.matrix,
      shadowLight.shadow.camera,
      useHiModel ? CENTER_X : CENTER_X + 1e4,
      CENTER_Z,
    );
    // 3 秒无交互后缓慢自动环绕
    const idle = now - lastInputMs;
    if (idle > 3e3) camYaw += 0.12 * frameDt * Math.min((idle - 3e3) / 2e3, 1);
    // 相机焦点 = 插值后的车体位置(无人机抬高 11m)
    const fx = snapBuf[0] + (snapBuf[4] - snapBuf[0]) * alpha;
    const fz = snapBuf[1] + (snapBuf[5] - snapBuf[1]) * alpha;
    const fy = groundY(fx, fz) + (currentKind === 5 ? 11 : 0);
    const focus = new Vector3(fx, fy + 1.5, fz);
    camera.position.set(
      focus.x + Math.cos(camYaw) * camDist * Math.cos(camPitch),
      focus.y + camDist * Math.sin(camPitch),
      focus.z + Math.sin(camYaw) * camDist * Math.cos(camPitch),
    );
    camera.lookAt(focus);
    const sec = now / 1e3;
    glowParticles.flush(sec);
    smokeParticles.flush(sec);
    beamPool.flush(sec);
    flashPool.flush(sec);
    shockwavePool.flush(sec);
    flashMap.update(renderer, sec);
    renderer.render(scene, camera);
  });
}

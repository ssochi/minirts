// 对战模式主模块 —— 创建渲染器/场景/世界,启动模拟 Worker,
// 主循环消费快照(插值上传车队)与事件环(分发开火/命中/死亡特效)。
// 模拟在 Worker 中 15Hz 推进,渲染端每帧在两帧快照间插值,互不阻塞。

import {
  WebGLRenderer,
  Scene,
  Color,
  FogExp2,
  DirectionalLight,
  Vector3,
  ACESFilmicToneMapping,
  PCFShadowMap,
} from 'three';
import { CONFIG } from '../core/config.js';
import { HEADER, EV, SNAP_STRIDE, EventReader } from '../sim/protocol.js';
import { createSimWorker, createSimChannel } from '../sim/channel.js';
import { RtsCamera } from '../ui/camera.js';
import { Hud } from '../ui/hud.js';
import { DiagnosticsOverlay } from '../ui/diagnostics.js';
import { GroundFlashMap } from '../render/ground-flash-map.js';
import { FleetRenderer } from '../render/fleet-renderer.js';
import { buildSky } from '../world/sky.js';
import { buildGround, buildObstacleMeshes, scatterGroundDetail } from '../world/ground.js';
import { generateObstacles } from '../world/map-gen.js';
import { ParticlePool } from '../render/fx/particles.js';
import { BeamPool } from '../render/fx/beams.js';
import { FlashPool, ShockwavePool } from '../render/fx/flashes.js';
import { WreckPool } from '../render/fx/wrecks.js';
import { DebrisPool } from '../render/fx/debris.js';

export function startBattle() {
  // ---------------- 渲染器与场景
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.55;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setSize(innerWidth, innerHeight);
  document.getElementById('app').appendChild(renderer.domElement);

  const scene = new Scene();
  scene.background = new Color(0x11151b); // 夜战深蓝灰(原值 1119515)
  scene.fog = new FogExp2(0x11151b, 7e-4);

  const cameraRig = new RtsCamera(renderer.domElement);
  const camera = cameraRig.camera;
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
  });

  // ---------------- 模拟 Worker 与通道
  const worker = createSimWorker();
  const channel = createSimChannel(worker, CONFIG.defaultRed, CONFIG.defaultBlue, CONFIG.seed);
  if (channel.mode === 'copy') {
    console.warn('[fallback] 无跨源隔离/SharedArrayBuffer,已切换到复制通道(Transferable 乒乓)模式。');
    const banner = document.getElementById('banner');
    banner.textContent = '降级模式:复制通道';
    banner.style.color = '#ffb454';
    banner.style.fontSize = '18px';
    banner.style.top = '8px';
    banner.style.display = 'block';
    setTimeout(() => {
      banner.style.display = 'none';
      banner.style.fontSize = '';
      banner.style.top = '';
      banner.style.color = '';
    }, 4e3);
  }

  const diag = new DiagnosticsOverlay(renderer);
  worker.addEventListener('message', (e) => {
    if (e.data?.kind === 'sim-stats' && e.data.stats) diag.simPhases = e.data.stats;
  });

  // ---------------- 世界
  const flashMap = new GroundFlashMap();
  const fleet = new FleetRenderer(scene, flashMap.texture);
  const cloudTime = { value: 0 };
  buildSky(scene);
  buildGround(scene, flashMap.texture, cloudTime);
  const obstacleMap = generateObstacles(CONFIG.seed); // 与 Worker 同种子同地图
  buildObstacleMeshes(scene, obstacleMap.shapes);
  scatterGroundDetail(scene, obstacleMap);
  const bannerEl = document.getElementById('banner');

  // 调试句柄(控制台可摸到全部核心对象)
  window.__dbg = {
    renderer,
    scene,
    rig: cameraRig,
    channel,
    diag,
    get views() {
      return channel.views;
    },
  };

  // ---------------- 跟随焦点的太阳影(只罩住相机附近 ±170m)
  const sunLight = new DirectionalLight(0xffeecf, 0.45); // 原值 16772815
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const shadowCam = sunLight.shadow.camera;
  shadowCam.left = -170;
  shadowCam.right = 170;
  shadowCam.top = 170;
  shadowCam.bottom = -170;
  shadowCam.near = 1;
  shadowCam.far = 900;
  shadowCam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0012;
  scene.add(sunLight, sunLight.target);

  // ---------------- 特效池
  const glowParticles = new ParticlePool(scene, 32768, true); // 炮口焰/火球/曳光弹
  const softParticles = new ParticlePool(scene, 32768, false); // 尘土/烟
  const beams = new BeamPool(scene);
  const wrecks = new WreckPool(scene, flashMap.texture);
  const debris = new DebrisPool(scene, flashMap.texture);
  const flashes = new FlashPool(scene);
  const scorch = new ShockwavePool(scene);
  diag.register('单位-远档', fleet.meshFar);
  diag.register('单位-近档', fleet.meshNear);
  diag.register('blob阴影', fleet.meshBlob);
  diag.register('近景投影', fleet.meshCaster);
  diag.register('粒子+光晕', [...glowParticles.meshes, ...softParticles.meshes]);
  diag.register('曳光', beams.meshes);
  diag.register('残骸', [wrecks.mesh]);
  diag.register('碎片', debris.meshes);
  diag.register('地面辉光', [flashes.mesh, scorch.mesh]);

  // ---------------- 主循环状态
  const now = () => performance.now() / 1e3;
  const recentDeaths = Array(96).fill(null); // 残骸冒烟用的环形死亡记录
  let recentDeathsHead = 0;
  let smokeLastT = 0;
  const scratch = new Vector3();
  let lastUpload = { x: 0, z: 0, d: 0 };
  let lastUploadMs = 0;
  let lastTick = 0;
  let lastTickMs = 0;
  let tickMs = 1e3 / CONFIG.simHz; // 实测 tick 间隔(EMA),插值进度的分母
  const hud = new Hud();
  hud.onSpeed = (speedX100) => {
    channel.sendCommand({ speedX100 });
  };
  hud.onRestart = (red, blue) => {
    channel.sendCommand({ restart: { red, blue } });
    bannerEl.style.display = 'none';
    lastTick = 0;
    tickMs = 1e3 / CONFIG.simHz;
  };
  let followIdx = -1; // F 键随机跟随一辆
  hud.onFollow = () => {
    followIdx = followIdx < 0 ? (Math.random() * channel.views.header[HEADER.COUNT]) | 0 : -1;
  };
  const selboxEl = document.getElementById('selbox');

  // ---------------- 指挥输入:框选 + 右键移动
  {
    const el = renderer.domElement;
    // 屏幕坐标 → 地面交点(y=0 平面,最远 4000)
    const groundPoint = (sx, sy) => {
      const v = new Vector3((sx / innerWidth) * 2 - 1, -(sy / innerHeight) * 2 + 1, 0.5);
      v.unproject(camera).sub(camera.position).normalize();
      const t = v.y < -0.001 ? -camera.position.y / v.y : 4e3;
      return [camera.position.x + v.x * Math.min(t, 4e3), camera.position.z + v.z * Math.min(t, 4e3)];
    };
    let startX = 0;
    let startY = 0;
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button === 0) {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
      }
    });
    addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.min(startX, e.clientX);
      const top = Math.min(startY, e.clientY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      if (w + h > 6) {
        selboxEl.style.display = 'block';
        selboxEl.style.left = `${left}px`;
        selboxEl.style.top = `${top}px`;
        selboxEl.style.width = `${w}px`;
        selboxEl.style.height = `${h}px`;
      }
    });
    addEventListener('pointerup', (e) => {
      if (!dragging || e.button !== 0) return;
      dragging = false;
      selboxEl.style.display = 'none';
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      if (w < 6 && h < 6) {
        channel.sendSelect([]); // 单击清选
        return;
      }
      const x0 = Math.min(startX, e.clientX);
      const x1 = Math.max(startX, e.clientX);
      const y0 = Math.min(startY, e.clientY);
      const y1 = Math.max(startY, e.clientY);
      // 屏幕矩形四角投到地面,送 Worker 做四边形选取
      channel.sendSelect([...groundPoint(x0, y0), ...groundPoint(x1, y0), ...groundPoint(x1, y1), ...groundPoint(x0, y1)]);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, z] = groundPoint(e.clientX, e.clientY);
      channel.sendMove(x, z);
      flashMap.spawn(x, z, now(), 0.6, 9, 0.9, 0.25, 1, 0.45); // 命令落点的青色地面脉冲
    });
  }
  addEventListener('keydown', (e) => {
    if (e.target?.tagName !== 'INPUT' && e.key === 'f') hud.onFollow();
  });

  // ---------------- 辅助:视野与采样

  // 距焦点 150m 内必播特效,更远按 22500/d² 概率抽样(海量战场限流)
  function nearFocus(x, z) {
    const dx = x - cameraRig.focus.x;
    const dz = z - cameraRig.focus.z;
    const d2 = dx * dx + dz * dz;
    return d2 < 22500 ? true : Math.random() < 22500 / d2;
  }

  // 相机四角投到地面的覆盖四边形(车队渲染器据此决定近档范围)
  function viewGroundCoverage() {
    camera.updateMatrixWorld();
    const out = [];
    for (const [nx, ny] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      scratch.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
      const t = scratch.y < -0.001 ? -camera.position.y / scratch.y : 4e3;
      const d = Math.min(t, 4e3);
      out.push(camera.position.x + scratch.x * d, camera.position.z + scratch.z * d);
    }
    return out;
  }

  // 相机大幅移动时在两 tick 之间补传一次快照,避免近档列表滞后
  function reuploadOnCameraMove(views) {
    const dist = cameraRig.camera.position.distanceTo(cameraRig.focus);
    const moved = Math.hypot(cameraRig.focus.x - lastUpload.x, cameraRig.focus.z - lastUpload.z);
    const t = performance.now();
    if ((moved > 10 || Math.abs(dist - lastUpload.d) > dist * 0.06) && t - lastUploadMs > 40) {
      const snap = views.snaps[views.header[HEADER.FRONT]];
      diag.time('upload', () =>
        fleet.uploadSnapshot(snap, views.header[HEADER.COUNT], cameraRig.focus.x, cameraRig.focus.z, viewGroundCoverage()),
      );
      lastUpload = { x: cameraRig.focus.x, z: cameraRig.focus.z, d: dist };
      lastUploadMs = t;
    }
  }

  // 残骸余烟:近 24 秒内的死亡点持续冒烟(0.45s 节流)
  function emitBattleSmoke(t) {
    if (t - smokeLastT < 0.45) return;
    smokeLastT = t;
    for (const d of recentDeaths) {
      if (!d || t - d.t > 24 || !nearFocus(d.x, d.z)) continue;
      softParticles.spawn(
        d.x + (Math.random() - 0.5) * 1.5,
        1 * d.s,
        d.z + (Math.random() - 0.5) * 1.5,
        t,
        (Math.random() - 0.5) * 0.5,
        1.3 + Math.random() * 0.9,
        (Math.random() - 0.5) * 0.5,
        3,
        (1.2 + Math.random() * 0.9) * d.s,
      );
    }
  }

  // 行进尘土:每帧抽样 ~256 个移动中的单位,在车尾扬尘
  function emitDustTrails(snap, count) {
    const t = now();
    const stride = Math.max(1, (count / 256) | 0);
    for (let i = (Math.random() * stride) | 0; i < count; i += stride) {
      const o = i * SNAP_STRIDE;
      const vx = snap[o + 4] - snap[o];
      const vz = snap[o + 5] - snap[o + 1];
      if (vx * vx + vz * vz < 0.05 || !nearFocus(snap[o + 4], snap[o + 5])) continue;
      const heading = snap[o + 6];
      softParticles.spawn(
        snap[o + 4] - Math.cos(heading) * 2.4,
        0.4,
        snap[o + 5] - Math.sin(heading) * 2.4,
        t,
        -vx * 2,
        0.8,
        -vz * 2,
        0,
        1.4,
      );
    }
  }

  // ---------------- 事件分发:模拟事件 → 特效
  function drainEvents(views) {
    new EventReader(views.evHead, views.evI32, views.evF32, CONFIG.eventCapacity).drain((type, a, b, c, d, e) => {
      if (type === EV.SHOT) {
        // 普通直射:(a,b)=炮口 (c,d)=落点 e=飞行秒
        if (!nearFocus(a, b)) return;
        const t = now();
        glowParticles.spawn(a, 1.6, b, t, 0, 0.5, 0, 1, 1.6);
        glowParticles.spawn(c, 0.8, d, t + e, 0, 2.5, 0, 2, 1.8);
        softParticles.spawn(c, 1, d, t + e, 0, 1.8, 0, 3, 1.2);
        beams.spawn(a, b, c, d, t, e);
        flashes.spawn(c, d, t + e, 5 + Math.random() * 2, 0);
        flashes.spawn(a, b, t, 3.5, 0);
        flashMap.spawn(a, b, t, 0.16, 9, 0.55);
        flashMap.spawn(c, d, t + e, 0.26, 10, 0.8);
      } else if (type === EV.GSHOT) {
        // 巨炮:全屏可感的大事件,不做距离抽样
        const t = now();
        const flight = Math.max(e, 0.1);
        glowParticles.spawn(a, 3.4, b, t, 0, 1.2, 0, 1, 6);
        softParticles.spawn(a, 2.8, b, t + 0.02, ((c - a) / flight) * 0.15, 1.6, ((d - b) / flight) * 0.15, 3, 3);
        flashes.spawn(a, b, t, 9, 0);
        glowParticles.spawn(a, 3, b, t, (c - a) / flight, -2 / flight + 1.5 * flight, (d - b) / flight, 4, 2.4, flight);
        for (let i = 0; i < 5; i++) {
          const ox = (Math.random() - 0.5) * 9;
          const oz = (Math.random() - 0.5) * 9;
          glowParticles.spawn(c + ox, 1, d + oz, t + flight + i * 0.045, ox * 0.8, 4 + Math.random() * 5, oz * 0.8, 2, 3.4);
        }
        softParticles.spawn(c, 1.6, d, t + flight + 0.08, 0, 2.6, 0, 3, 5.5);
        softParticles.spawn(c, 1, d, t + flight + 0.2, 0, 1.8, 0, 3, 4);
        flashes.spawn(c, d, t + flight, 16 * 1.2, 2);
        flashes.spawn(c, d, t + flight + 0.05, 12, 1);
        scorch.spawn(c, d, t + flight, 8.5);
        flashMap.spawn(a, b, t, 0.3, 24, 2.2);
        flashMap.spawn(c, d, t + flight, 0.65, 32, 3);
      } else if (type === EV.RSHOT) {
        // 火箭弹:抛物线曳光 + 小 AOE
        if (!nearFocus(a, b) && !nearFocus(c, d)) return;
        const t = now();
        const flight = Math.max(e, 0.1);
        glowParticles.spawn(a, 2.2, b, t, 0, 0.6, 0, 1, 2.2);
        glowParticles.spawn(a, 2, b, t, (c - a) / flight, -1 / flight + 1.5 * flight, (d - b) / flight, 4, 1.3, flight);
        glowParticles.spawn(c, 0.9, d, t + flight, 0, 3, 0, 2, 2.4);
        softParticles.spawn(c, 1.2, d, t + flight + 0.05, 0, 2, 0, 3, 2.4);
        flashes.spawn(c, d, t + flight, 6, 0);
        scorch.spawn(c, d, t + flight, 4);
        flashMap.spawn(c, d, t + flight, 0.3, 13, 1.1);
      } else if (type === EV.BEAM) {
        // 磁轨:直线电弧,几乎瞬发
        if (!nearFocus(a, b) && !nearFocus(c, d)) return;
        const t = now();
        const flight = Math.max(e, 0.06);
        glowParticles.spawn(a, 1.9, b, t, 0, 0.3, 0, 1, 2);
        glowParticles.spawn(a, 1.8, b, t, (c - a) / flight, 0, (d - b) / flight, 5, 1.5, flight);
        glowParticles.spawn(c, 1.5, d, t + flight, 0, 1.5, 0, 2, 1.6);
        flashMap.spawn(c, d, t + flight, 0.2, 9, 0.8, 0.55, 0.85, 1);
      } else if (type === EV.DSHOT) {
        // 无人机俯射:高空直线下打
        if (!nearFocus(a, b)) return;
        const t = now();
        const flight = Math.max(e, 0.1);
        glowParticles.spawn(a, 10.6, b, t, 0, 0, 0, 1, 1.4);
        glowParticles.spawn(a, 10.4, b, t, (c - a) / flight, -9.200000000000001 / flight, (d - b) / flight, 5, 1.1, flight);
        glowParticles.spawn(c, 1, d, t + flight, 0, 1.8, 0, 2, 1.3);
      } else if (type === EV.DEATH) {
        // (a,b)=位置 c=朝向 e=兵种;巨坦必播,其余按距离抽样
        const t = now();
        const kind = (e + 0.5) | 0;
        const isGiant = kind === 1;
        const isDrone = kind === 5;
        const dx = a - cameraRig.focus.x;
        const dz = b - cameraRig.focus.z;
        const d2 = dx * dx + dz * dz;
        const scale = isGiant ? 2.4 : kind === 2 ? 0.7 : 1;
        if (isGiant || Math.random() < Math.max(0.3, 22500 / d2)) {
          const bursts = isGiant ? 8 : 3;
          const spread = isGiant ? 6 : 2;
          const size = isGiant ? 3.6 : isDrone ? 1.8 : 2.6;
          const baseY = isDrone ? 10 : 0.8;
          for (let i = 0; i < bursts; i++)
            glowParticles.spawn(
              a + (Math.random() - 0.5) * spread,
              baseY,
              b + (Math.random() - 0.5) * spread,
              t + i * 0.06,
              (Math.random() - 0.5) * 5,
              isDrone ? -4 : 3 + Math.random() * 4,
              (Math.random() - 0.5) * 5,
              2,
              size,
            );
          if (!isDrone) softParticles.spawn(a, 1.5, b, t + 0.1, 0, 2.2, 0, 3, isGiant ? 6 : 3.5);
          isDrone ? debris.burstAir(a, b, 10.5, t, 0.7) : debris.burst(a, b, t, scale, isGiant);
          flashMap.spawn(a, b, t, 0.55, isGiant ? 36 : 15, isGiant ? 3.2 : 1.5);
        }
        if (!isDrone) {
          wrecks.spawn(a, b, c, t, scale);
          flashes.spawn(a, b, t + 0.05, isGiant ? 15 : 9, 1);
          recentDeaths[recentDeathsHead++ % recentDeaths.length] = { x: a, z: b, t, s: scale };
        }
        if (isGiant) {
          flashes.spawn(a, b, t, 18, 2);
          scorch.spawn(a, b, t, 13);
        }
      }
    });
  }

  // ---------------- 主循环
  renderer.setAnimationLoop(() => {
    cameraRig.update();
    const views = channel.views;
    const tick = Atomics.load(views.header, HEADER.TICK);
    if (tick !== lastTick) {
      // 新 tick 到达:更新实测 tick 间隔,整帧上传 + 事件分发
      const t = performance.now();
      if (lastTick !== 0) tickMs = tickMs * 0.8 + (t - lastTickMs) * 0.2;
      lastTick = tick;
      lastTickMs = t;
      const snap = views.snaps[views.header[HEADER.FRONT]];
      const count = views.header[HEADER.COUNT];
      diag.time('upload', () =>
        fleet.uploadSnapshot(snap, count, cameraRig.focus.x, cameraRig.focus.z, viewGroundCoverage()),
      );
      lastUpload = { x: cameraRig.focus.x, z: cameraRig.focus.z, d: cameraRig.camera.position.distanceTo(cameraRig.focus) };
      lastUploadMs = performance.now();
      drainEvents(views);
      emitDustTrails(snap, count);

      const aliveRed = views.header[HEADER.ALIVE_RED];
      const aliveBlue = views.header[HEADER.ALIVE_BLUE];
      if ((aliveRed === 0 || aliveBlue === 0) && aliveRed + aliveBlue > 0 && bannerEl.style.display !== 'block') {
        bannerEl.style.display = 'block';
        bannerEl.textContent = aliveRed === 0 ? '蓝方胜利' : '红方胜利';
        bannerEl.style.color = aliveRed === 0 ? '#4da3ff' : '#ff5a52';
      }
    }

    // 帧内插值进度(0..1):本帧时刻在两 tick 间的位置
    const lerp = Math.min((performance.now() - lastTickMs) / tickMs, 1);
    reuploadOnCameraMove(views);
    fleet.setFrame(lerp, now());

    // 太阳影随焦点平移
    sunLight.position.set(cameraRig.focus.x + 250, 237.5, cameraRig.focus.z + 150);
    sunLight.target.position.set(cameraRig.focus.x, 0, cameraRig.focus.z);
    fleet.setShadow(
      sunLight.shadow.map ? sunLight.shadow.map.texture : null,
      sunLight.shadow.matrix,
      sunLight.shadow.camera,
      cameraRig.focus.x,
      cameraRig.focus.z,
    );

    // F 键跟随:相机焦点缓动到目标单位插值位置
    if (followIdx >= 0) {
      const count = views.header[HEADER.COUNT];
      if (followIdx >= count) followIdx = -1;
      else {
        const snap = views.snaps[views.header[HEADER.FRONT]];
        const o = followIdx * SNAP_STRIDE;
        const x = snap[o] + (snap[o + 4] - snap[o]) * lerp;
        const z = snap[o + 1] + (snap[o + 5] - snap[o + 1]) * lerp;
        cameraRig.focus.x += (x - cameraRig.focus.x) * 0.15;
        cameraRig.focus.z += (z - cameraRig.focus.z) * 0.15;
      }
    }

    const t = now();
    cloudTime.value = t;
    emitBattleSmoke(t);
    glowParticles.flush(t);
    softParticles.flush(t);
    beams.flush(t);
    wrecks.flush(t);
    debris.flush(t);
    flashes.flush(t);
    scorch.flush(t);
    diag.time('lightGrid', () => flashMap.update(renderer, t));
    diag.time('render', () => diag.gpuWrap(() => renderer.render(scene, camera)));
    diag.extra['tris/实例'] =
      `${(renderer.info.render.triangles / 1e6).toFixed(1)}M / 远${fleet.lastCounts.far} 近${fleet.lastCounts.near}`;
    diag.frame();
    hud.frame(performance.now(), views, renderer.info.render.calls, glowParticles.count + softParticles.count);
  });
}

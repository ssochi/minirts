// 模拟 Worker —— 以 15Hz 推进至多 131072 个单位的战斗模拟。
// 主线程只读快照(双缓冲)与事件环;本线程拥有全部权威状态。
// 管线: 空间哈希重建 → 流场刷新(分帧) → 转向 → 碰撞 → 索敌 → 开火/结算 → 清尸 → 发布快照。
// 与主线程共享 config/protocol/rng/map-gen 模块,两端用同一种子独立重建同一张地图。

import { CONFIG, KIND_STATS, KIND_FLY, TICK_DT } from '../core/config.js';
import { HEADER, EV, SNAP_STRIDE, sabLayout, makeViews, EventWriter } from './protocol.js';
import { makeRng } from '../core/rng.js';
import { generateObstacles, GRID_W, GRID_H } from '../world/map-gen.js';

const INF = 1e9;

// ---------------------------------------------------------------- 单位状态(SoA)

class UnitState {
  nextId = 1;
  count = 0;

  constructor(cap) {
    this.cap = cap;
    const f32 = () => new Float32Array(cap);
    const i32 = () => new Int32Array(cap);
    const u8 = () => new Uint8Array(cap);
    this.posX = f32();
    this.posZ = f32();
    this.heading = f32();
    this.turretYaw = f32();
    this.prevX = f32();
    this.prevZ = f32();
    this.prevHeading = f32();
    this.prevTurretYaw = f32();
    this.hp = f32();
    this.cooldown = f32();
    this.orderX = f32();
    this.orderZ = f32();
    this.recoil = f32();
    this.targetIdx = i32();
    this.targetId = i32(); // 目标的 id 快照,防止 swap-remove 后索引串号
    this.ids = i32();
    this.team = u8();
    this.state = u8(); // 0=待机 1=交战 2=已死(待清扫)
    this.holding = u8(); // 本 tick 是否站桩(影响碰撞推挤优先级)
    this.kind = u8();
    this.selected = u8();
    this.order = u8(); // 0=无 1=移动中 2=到达驻守
  }

  // 按军队规模混编:小军纯坦克,大军按比例编入特殊兵种
  static composition(total) {
    if (total < CONFIG.specialMinArmy)
      return { giant: 0, scout: 0, mlrs: 0, destroyer: 0, drone: 0, tank: total };
    const giant = Math.max(1, Math.round(total / CONFIG.giantEvery));
    const scout = Math.round(total * CONFIG.mix.scout);
    const mlrs = Math.round(total * CONFIG.mix.mlrs);
    const destroyer = Math.round(total * CONFIG.mix.destroyer);
    const drone = Math.round(total * CONFIG.mix.drone);
    return { giant, scout, mlrs, destroyer, drone, tank: total - giant - scout - mlrs - drone - destroyer };
  }

  spawnArmies(red, blue, rng) {
    this.count = 0;
    this.spawnSide(red, 0, rng);
    this.spawnSide(blue, 1, rng);
    this.nextIdCheck();
  }

  // 红方从 x=320 向左排兵,蓝方镜像;各兵种分纵列梯次配置
  spawnSide(total, team, rng) {
    const colX = (d) => (team === 0 ? 320 - d : CONFIG.mapW - 320 + d);
    const comp = UnitState.composition(total);
    const tankDepth = this.spawnBlock(comp.tank, 0, team, colX(0), rng, 3.4, 'block');
    this.spawnBlock(comp.scout, 2, team, colX(-90), rng, 5, 'strip'); // 侦察车前出
    this.spawnBlock(comp.drone, 5, team, colX(15), rng, 7, 'strip');
    let d = tankDepth + 10;
    d += this.spawnBlock(comp.destroyer, 4, team, colX(d), rng, 5, 'strip') + 10;
    d += this.spawnBlock(comp.mlrs, 3, team, colX(d), rng, 6, 'strip') + 12;
    this.spawnBlock(comp.giant, 1, team, colX(d), rng, 18, 'strip');
  }

  // 返回该方阵占用的纵深;spacing 会按容量上限自动收缩
  spawnBlock(count, kind, team, x, rng, spacing, shape) {
    if (count <= 0) return 0;
    const usableH = CONFIG.mapH - 40;
    const s = Math.max(2, Math.min(spacing, Math.sqrt((310 * usableH) / count) * 0.98));
    let cols = Math.min(shape === 'strip' ? count : Math.ceil(Math.sqrt(count * 2.2)), Math.floor(usableH / s));
    if (Math.ceil(count / cols) * s > 310) cols = Math.ceil(count / Math.floor(310 / s));
    const dir = team === 0 ? -1 : 1;
    const stats = KIND_STATS[kind];
    for (let n = 0; n < count; n++) {
      const row = (n / cols) | 0;
      const col = n % cols;
      const i = this.count++;
      const px = x + dir * row * s + rng.range(-0.6, 0.6);
      const pz = CONFIG.mapH / 2 + (col - cols / 2) * s + rng.range(-0.6, 0.6);
      this.posX[i] = Math.min(Math.max(px, 6), CONFIG.mapW - 6);
      this.posZ[i] = Math.min(Math.max(pz, 6), CONFIG.mapH - 6);
      this.heading[i] = team === 0 ? 0 : Math.PI;
      this.turretYaw[i] = this.heading[i];
      this.prevX[i] = this.posX[i];
      this.prevZ[i] = this.posZ[i];
      this.prevHeading[i] = this.heading[i];
      this.prevTurretYaw[i] = this.turretYaw[i];
      this.hp[i] = stats.hp;
      this.cooldown[i] = n % 16; // 错开首轮开火
      this.targetIdx[i] = -1;
      this.targetId[i] = 0;
      this.team[i] = team;
      this.state[i] = 0;
      this.holding[i] = 0;
      this.kind[i] = kind;
      this.ids[i] = this.nextId++;
    }
    return Math.ceil(count / cols) * s;
  }

  nextIdCheck() {
    if (this.nextId > 2e9) this.nextId = 1;
  }

  hasValidTarget(i) {
    const t = this.targetIdx[i];
    return t >= 0 && t < this.count && this.ids[t] === this.targetId[i];
  }

  // swap-remove:末尾单位搬入空位,索引失效由 targetId 校验兜底
  kill(i) {
    const last = --this.count;
    if (i === last) return;
    this.posX[i] = this.posX[last];
    this.posZ[i] = this.posZ[last];
    this.heading[i] = this.heading[last];
    this.turretYaw[i] = this.turretYaw[last];
    this.prevX[i] = this.prevX[last];
    this.prevZ[i] = this.prevZ[last];
    this.prevHeading[i] = this.prevHeading[last];
    this.prevTurretYaw[i] = this.prevTurretYaw[last];
    this.hp[i] = this.hp[last];
    this.cooldown[i] = this.cooldown[last];
    this.targetIdx[i] = this.targetIdx[last];
    this.targetId[i] = this.targetId[last];
    this.team[i] = this.team[last];
    this.state[i] = this.state[last];
    this.holding[i] = this.holding[last];
    this.kind[i] = this.kind[last];
    this.selected[i] = this.selected[last];
    this.order[i] = this.order[last];
    this.orderX[i] = this.orderX[last];
    this.orderZ[i] = this.orderZ[last];
    this.recoil[i] = this.recoil[last];
    this.ids[i] = this.ids[last];
  }
}

// ---------------------------------------------------------------- 空间哈希(计数排序桶)

class SpatialGrid {
  constructor(w, h, cellSize, cap) {
    this.cellSize = cellSize;
    this.cellsX = Math.ceil(w / cellSize);
    this.cellsZ = Math.ceil(h / cellSize);
    this.nCells = this.cellsX * this.cellsZ;
    this.inv = 1 / cellSize;
    this.cellStart = new Int32Array(this.nCells + 1);
    this.cursor = new Int32Array(this.nCells);
    this.indices = new Int32Array(cap);
    this.cellOf = new Int32Array(cap);
  }
  cellX(x) {
    const c = (x * this.inv) | 0;
    return c < 0 ? 0 : c >= this.cellsX ? this.cellsX - 1 : c;
  }
  cellZ(z) {
    const c = (z * this.inv) | 0;
    return c < 0 ? 0 : c >= this.cellsZ ? this.cellsZ - 1 : c;
  }
  build(posX, posZ, count) {
    this.cursor.fill(0);
    for (let i = 0; i < count; i++) {
      const c = this.cellZ(posZ[i]) * this.cellsX + this.cellX(posX[i]);
      this.cellOf[i] = c;
      this.cursor[c]++;
    }
    let acc = 0;
    for (let c = 0; c < this.nCells; c++) {
      this.cellStart[c] = acc;
      acc += this.cursor[c];
      this.cursor[c] = this.cellStart[c];
    }
    this.cellStart[this.nCells] = acc;
    for (let i = 0; i < count; i++) this.indices[this.cursor[this.cellOf[i]]++] = i;
  }
  queryCircle(posX, posZ, x, z, r, out) {
    const r2 = r * r;
    const x0 = this.cellX(x - r);
    const x1 = this.cellX(x + r);
    const z0 = this.cellZ(z - r);
    const z1 = this.cellZ(z + r);
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * this.cellsX + cx;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const i = this.indices[k];
          const dx = posX[i] - x;
          const dz = posZ[i] - z;
          if (dx * dx + dz * dz <= r2) out.push(i);
        }
      }
  }
}

// ---------------------------------------------------------------- 障碍距离场(两遍 chamfer)

class ObstacleSdf {
  constructor(w, h, cell, blocked) {
    this.w = w;
    this.h = h;
    this.cell = cell;
    this.invCell = 1 / cell;
    const dist = new Float32Array(w * h).fill(1e9);
    for (let i = 0; i < w * h; i++) if (blocked[i]) dist[i] = 0;
    const straight = cell;
    const diag = cell * Math.SQRT2;
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        let d = dist[i];
        if (x > 0) d = Math.min(d, dist[i - 1] + straight);
        if (z > 0) d = Math.min(d, dist[i - w] + straight);
        if (x > 0 && z > 0) d = Math.min(d, dist[i - w - 1] + diag);
        if (x < w - 1 && z > 0) d = Math.min(d, dist[i - w + 1] + diag);
        dist[i] = d;
      }
    for (let z = h - 1; z >= 0; z--)
      for (let x = w - 1; x >= 0; x--) {
        const i = z * w + x;
        let d = dist[i];
        if (x < w - 1) d = Math.min(d, dist[i + 1] + straight);
        if (z < h - 1) d = Math.min(d, dist[i + w] + straight);
        if (x < w - 1 && z < h - 1) d = Math.min(d, dist[i + w + 1] + diag);
        if (x > 0 && z < h - 1) d = Math.min(d, dist[i + w - 1] + diag);
        dist[i] = d;
      }
    this.dist = dist;
  }
  sample(x, z) {
    let cx = (x * this.invCell) | 0;
    let cz = (z * this.invCell) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.w) cx = this.w - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.h) cz = this.h - 1;
    return this.dist[cz * this.w + cx];
  }
  // 距离场梯度 = 远离障碍的单位向量
  grad(x, z, out) {
    const c = this.cell;
    const gx = this.sample(x + c, z) - this.sample(x - c, z);
    const gz = this.sample(x, z + c) - this.sample(x, z - c);
    const len = Math.hypot(gx, gz);
    if (len < 1e-6) {
      out.x = 0;
      out.z = 0;
      return;
    }
    out.x = gx / len;
    out.z = gz / len;
  }
}

// 流场代价: 障碍=255(不可通行) 贴墙=6 开阔=1,引导大军绕开瓶颈
function buildFlowCost(blocked, sdf, w, h, cell) {
  const cost = new Uint8Array(w * h);
  for (let z = 0; z < h; z++)
    for (let x = 0; x < w; x++) {
      const i = z * w + x;
      if (blocked[i]) {
        cost[i] = 255;
        continue;
      }
      cost[i] = sdf.sample((x + 0.5) * cell, (z + 0.5) * cell) <= cell ? 6 : 1;
    }
  return cost;
}

// ---------------------------------------------------------------- 流场(多源 Dijkstra + 下降方向)

class FlowField {
  heapSize = 0;

  constructor(w, h, cell) {
    this.w = w;
    this.h = h;
    this.cell = cell;
    const n = w * h;
    this.dist = new Float32Array(n);
    this.dirX = new Float32Array(n);
    this.dirZ = new Float32Array(n);
    this.heapId = new Int32Array(n * 8);
    this.heapKey = new Float32Array(n * 8);
    this.inv = 1 / cell;
  }
  push(id, key) {
    let n = this.heapSize++;
    const ids = this.heapId;
    const keys = this.heapKey;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (keys[p] <= key) break;
      ids[n] = ids[p];
      keys[n] = keys[p];
      n = p;
    }
    ids[n] = id;
    keys[n] = key;
  }
  pop() {
    const ids = this.heapId;
    const keys = this.heapKey;
    const top = ids[0];
    const lastId = ids[--this.heapSize];
    const lastKey = keys[this.heapSize];
    let n = 0;
    for (;;) {
      let c = n * 2 + 1;
      if (c >= this.heapSize || (c + 1 < this.heapSize && keys[c + 1] < keys[c] && c++, keys[c] >= lastKey)) break;
      ids[n] = ids[c];
      keys[n] = keys[c];
      n = c;
    }
    ids[n] = lastId;
    keys[n] = lastKey;
    return top;
  }
  // 以全体敌军位置为源做多源 Dijkstra,再为每格求最陡下降方向
  compute(cost, srcX, srcZ, srcCount) {
    const { w, h, dist } = this;
    dist.fill(INF);
    this.heapSize = 0;
    for (let s = 0; s < srcCount; s++) {
      let cx = (srcX[s] * this.inv) | 0;
      let cz = (srcZ[s] * this.inv) | 0;
      if (cx < 0) cx = 0;
      else if (cx >= w) cx = w - 1;
      if (cz < 0) cz = 0;
      else if (cz >= h) cz = h - 1;
      const i = cz * w + cx;
      if (cost[i] === 255 || dist[i] === 0) continue;
      dist[i] = 0;
      this.push(i, 0);
    }
    const straight = this.cell;
    const diag = this.cell * Math.SQRT2;
    while (this.heapSize > 0) {
      const i = this.pop();
      const d = dist[i];
      const x = i % w;
      const z = (i / w) | 0;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
          const ni = nz * w + nx;
          if (cost[ni] === 255) continue;
          const nd = d + (dx !== 0 && dz !== 0 ? diag : straight) * cost[ni];
          if (nd < dist[ni]) {
            dist[ni] = nd;
            this.push(ni, nd);
          }
        }
    }
    const { dirX, dirZ } = this;
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++) {
        const i = z * w + x;
        if (dist[i] >= INF) {
          dirX[i] = 0;
          dirZ[i] = 0;
          continue;
        }
        let best = dist[i];
        let bx = 0;
        let bz = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const nz = z + dz;
            if (nx < 0 || nx >= w || nz < 0 || nz >= h) continue;
            const nd = dist[nz * w + nx];
            if (nd < best) {
              best = nd;
              bx = dx;
              bz = dz;
            }
          }
        const len = Math.hypot(bx, bz);
        if (len > 0) {
          dirX[i] = bx / len;
          dirZ[i] = bz / len;
        } else {
          dirX[i] = 0;
          dirZ[i] = 0;
        }
      }
  }
  sample(x, z, out) {
    let cx = (x * this.inv) | 0;
    let cz = (z * this.inv) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.w) cx = this.w - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.h) cz = this.h - 1;
    const i = cz * this.w + cx;
    out.x = this.dirX[i];
    out.z = this.dirZ[i];
  }
  sampleDist(x, z) {
    let cx = (x * this.inv) | 0;
    let cz = (z * this.inv) | 0;
    if (cx < 0) cx = 0;
    else if (cx >= this.w) cx = this.w - 1;
    if (cz < 0) cz = 0;
    else if (cz >= this.h) cz = this.h - 1;
    return this.dist[cz * this.w + cx];
  }
}

// ---------------------------------------------------------------- 转向

const wrapAngle = (a) => ((((a + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;

const flowDir = { x: 0, z: 0 };
const wallGrad = { x: 0, z: 0 };

// 每单位决策期望方向(玩家命令 > 交战机动 > 防线驻守 > 流场行军),
// 叠加邻域分离与避墙,再按车体转速/炮塔转速积分。
function steer(state, grid, sdf, flows) {
  const { posX, posZ, heading, turretYaw, team, state: st, targetIdx } = state;
  const sepR = CONFIG.separationRadius;
  const sepR2 = sepR * sepR;
  for (let i = 0; i < state.count; i++) {
    if (st[i] === 2) continue;
    let dx = 0;
    let dz = 0;
    let hold = 0;
    let reverse = 0; // 倒车保距(磁轨/火箭炮)
    const stats = KIND_STATS[state.kind[i]];
    const flying = stats.fly === 1;
    const enemyDist = flows[team[i]].sampleDist(posX[i], posZ[i]);

    if (state.order[i] === 1) {
      // 玩家移动命令
      dx = state.orderX[i] - posX[i];
      dz = state.orderZ[i] - posZ[i];
      const d = Math.hypot(dx, dz);
      if (d < 6) {
        state.order[i] = 2;
        hold = +!flying;
      } else {
        dx /= d;
        dz /= d;
      }
    } else if (state.order[i] === 2) hold = +!flying;
    else if (st[i] === 1 && state.hasValidTarget(i)) {
      // 交战机动
      const t = targetIdx[i];
      dx = posX[t] - posX[i];
      dz = posZ[t] - posZ[i];
      const d = Math.hypot(dx, dz);
      if (d > 0.001) {
        dx /= d;
        dz /= d;
      }
      const fleeing = (stats.hitRun === 1 || stats.kite > 0) && state.hp[i] < stats.hp * 0.28;
      if (!flying && stats.hitRun === 1 && (fleeing || state.cooldown[i] > stats.cooldown * 0.45)) {
        // 打了就跑:冷却期掉头脱离
        dx = -dx;
        dz = -dz;
      } else if (!flying && stats.kite > 0 && (fleeing || d < stats.range * stats.kite)) reverse = 1;
      else {
        const nearLine = enemyDist <= CONFIG.attackRange * (state.holding[i] === 1 ? 1.15 : 0.9);
        if (!flying && (d <= stats.range * 0.92 || nearLine)) hold = 1;
      }
    } else if (!flying && enemyDist <= CONFIG.attackRange * 0.65) hold = 1; // 敌阵贴脸,站桩输出
    else {
      // 行军:远离战线时优先横向直进(避免全军挤向流场最短路),否则跟流场
      const flow = flows[team[i]];
      flow.sample(posX[i], posZ[i], flowDir);
      const fwd = team[i] === 0 ? 1 : -1;
      if (
        flowDir.x * fwd > 0.3 &&
        flow.sampleDist(posX[i], posZ[i]) > CONFIG.marchFlowDist &&
        (flying || (sdf.sample(posX[i] + fwd * 6, posZ[i]) > 2 && sdf.sample(posX[i] + fwd * 12, posZ[i]) > 2))
      ) {
        dx = fwd;
        dz = 0;
      } else {
        dx = flowDir.x;
        dz = flowDir.z;
      }
    }

    // 邻域分离(只与同为地面/飞行的单位互斥,上限 neighborCap 个)
    let sepX = 0;
    let sepZ = 0;
    let neighbors = 0;
    const cx = grid.cellX(posX[i]);
    const cz = grid.cellZ(posZ[i]);
    outer: for (let oz = -1; oz <= 1; oz++)
      for (let ox = -1; ox <= 1; ox++) {
        const c = (cz + oz) * grid.cellsX + (cx + ox);
        if (c < 0 || c >= grid.nCells) continue;
        for (let k = grid.cellStart[c]; k < grid.cellStart[c + 1]; k++) {
          const j = grid.indices[k];
          if (j === i || KIND_FLY[state.kind[j]] !== stats.fly) continue;
          const ddx = posX[i] - posX[j];
          const ddz = posZ[i] - posZ[j];
          const d2 = ddx * ddx + ddz * ddz;
          if (d2 > sepR2 || d2 < 1e-6) continue;
          const d = Math.sqrt(d2);
          const wgt = (1 - d / sepR) / d;
          sepX += ddx * wgt;
          sepZ += ddz * wgt;
          if (++neighbors >= CONFIG.neighborCap) break outer;
        }
      }

    // 避墙:距离场近墙时沿梯度外推
    if (!flying) {
      const wd = sdf.sample(posX[i], posZ[i]);
      if (wd < CONFIG.wallAvoidDist) {
        sdf.grad(posX[i], posZ[i], wallGrad);
        const k = 1 - wd / CONFIG.wallAvoidDist;
        dx += wallGrad.x * k * 2;
        dz += wallGrad.z * k * 2;
      }
    }

    const sepLen = Math.hypot(sepX, sepZ);
    if (sepLen > 0.8) {
      sepX *= 0.8 / sepLen;
      sepZ *= 0.8 / sepLen;
    }
    dx += sepX;
    dz += sepZ;

    // 车体按转速转向,速度随朝向偏差余弦衰减;倒车半速
    let speed = 0;
    if (Math.hypot(dx, dz) > 0.05 && !hold) {
      const err = wrapAngle(Math.atan2(dz, dx) - heading[i]);
      const maxTurn = stats.turn * TICK_DT;
      heading[i] += Math.abs(err) <= maxTurn ? err : Math.sign(err) * maxTurn;
      speed = reverse
        ? -stats.speed * 0.55 * Math.max(0, Math.cos(err))
        : stats.speed * Math.max(flying ? 0.5 : 0, Math.cos(err));
    }
    posX[i] += Math.cos(heading[i]) * speed * TICK_DT;
    posZ[i] += Math.sin(heading[i]) * speed * TICK_DT;
    state.holding[i] = hold;

    // 炮塔独立转向目标
    let aim = heading[i];
    if (state.hasValidTarget(i)) {
      const t = targetIdx[i];
      aim = Math.atan2(posZ[t] - posZ[i], posX[t] - posX[i]);
    }
    const tErr = wrapAngle(aim - turretYaw[i]);
    const maxTurret = stats.turretRate * TICK_DT;
    turretYaw[i] += Math.abs(tErr) <= maxTurret ? tErr : Math.sign(tErr) * maxTurret;
  }
}

// ---------------------------------------------------------------- 碰撞

const collideGrad = { x: 0, z: 0 };
const MAX_PUSH = 0.6;

// 成对最小平移分离(迭代 iterations 轮)。站桩方不动,移动方让路;
// 地面单位额外被障碍 SDF 推出,最后钳制在地图内。
function resolveCollisions(state, grid, sdf, iterations) {
  const { posX, posZ, state: st, holding, kind } = state;
  for (let pass = 0; pass < iterations; pass++)
    for (let i = 0; i < state.count; i++) {
      if (st[i] === 2) continue;
      const fly = KIND_FLY[kind[i]];
      const radius = KIND_STATS[kind[i]].radius;
      const reach = radius > 2 ? 2 : 1; // 巨型坦克搜 5×5 邻域
      const cx = grid.cellX(posX[i]);
      const cz = grid.cellZ(posZ[i]);
      for (let oz = -reach; oz <= reach; oz++)
        for (let ox = -reach; ox <= reach; ox++) {
          const c = (cz + oz) * grid.cellsX + (cx + ox);
          if (c < 0 || c >= grid.nCells) continue;
          for (let k = grid.cellStart[c]; k < grid.cellStart[c + 1]; k++) {
            const j = grid.indices[k];
            if (j <= i || st[j] === 2 || KIND_FLY[kind[j]] !== fly) continue;
            const dx = posX[j] - posX[i];
            const dz = posZ[j] - posZ[i];
            const d2 = dx * dx + dz * dz;
            const minD = radius + KIND_STATS[kind[j]].radius;
            if (d2 >= minD * minD || d2 < 1e-9) continue;
            const d = Math.sqrt(d2);
            const push = Math.min((minD - d) * 0.5, MAX_PUSH);
            const nx = dx / d;
            const nz = dz / d;
            const iHolds = holding[i];
            if (iHolds === holding[j]) {
              posX[i] -= nx * push;
              posZ[i] -= nz * push;
              posX[j] += nx * push;
              posZ[j] += nz * push;
            } else if (iHolds) {
              const p = Math.min(push * 2, MAX_PUSH);
              posX[j] += nx * p;
              posZ[j] += nz * p;
            } else {
              const p = Math.min(push * 2, MAX_PUSH);
              posX[i] -= nx * p;
              posZ[i] -= nz * p;
            }
          }
        }
      if (!fly) {
        const wd = sdf.sample(posX[i], posZ[i]);
        if (wd < radius) {
          sdf.grad(posX[i], posZ[i], collideGrad);
          const push = Math.min(radius - wd, MAX_PUSH);
          posX[i] += collideGrad.x * push;
          posZ[i] += collideGrad.z * push;
        }
      }
      if (posX[i] < 2) posX[i] = 2;
      else if (posX[i] > CONFIG.mapW - 2) posX[i] = CONFIG.mapW - 2;
      if (posZ[i] < 2) posZ[i] = 2;
      else if (posZ[i] > CONFIG.mapH - 2) posZ[i] = CONFIG.mapH - 2;
    }
}

// ---------------------------------------------------------------- 索敌

// 分桶轮询(每 tick 只处理 1/retargetBuckets 的单位)。
// 从单位所在格向外按环扩张找最近敌人,找到后再多搜一环即止。
function retarget(state, grid, flows, bucket) {
  const { posX, posZ, team, state: st } = state;
  for (let i = bucket; i < state.count; i += CONFIG.retargetBuckets) {
    if (st[i] === 2) continue;
    const range = KIND_STATS[state.kind[i]].range;
    const range2 = range * range;
    if (state.hasValidTarget(i)) {
      const t = state.targetIdx[i];
      const dx = posX[t] - posX[i];
      const dz = posZ[t] - posZ[i];
      if (dx * dx + dz * dz < range2) continue; // 现有目标仍在射程,不换
    }
    if (flows[team[i]].sampleDist(posX[i], posZ[i]) > range * 2) {
      // 敌军太远,清除目标转入行军
      state.targetIdx[i] = -1;
      st[i] = 0;
      continue;
    }
    const maxRing = Math.ceil(range / CONFIG.gridCell) + 1;
    const cx = grid.cellX(posX[i]);
    const cz = grid.cellZ(posZ[i]);
    let best = -1;
    let bestD2 = range2;
    let foundRing = -1;
    for (let ring = 0; ring <= maxRing && !(foundRing >= 0 && ring > foundRing + 1); ring++) {
      const x0 = cx - ring;
      const x1 = cx + ring;
      const z0 = cz - ring;
      const z1 = cz + ring;
      for (let gz = z0; gz <= z1; gz++) {
        if (gz < 0 || gz >= grid.cellsZ) continue;
        const isEdgeRow = gz === z0 || gz === z1;
        for (let gx = x0; gx <= x1; gx += isEdgeRow ? 1 : x1 - x0 || 1) {
          if (gx < 0 || gx >= grid.cellsX) continue;
          const c = gz * grid.cellsX + gx;
          for (let k = grid.cellStart[c]; k < grid.cellStart[c + 1]; k++) {
            const j = grid.indices[k];
            if (team[j] === team[i] || st[j] === 2) continue;
            const dx = posX[j] - posX[i];
            const dz = posZ[j] - posZ[i];
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = j;
              if (foundRing < 0) foundRing = ring;
            }
          }
        }
      }
    }
    if (best >= 0) {
      state.targetIdx[i] = best;
      state.targetId[i] = state.ids[best];
      st[i] = 1;
    } else {
      state.targetIdx[i] = -1;
      st[i] = 0;
    }
  }
}

// ---------------------------------------------------------------- 伤害队列(飞行时间延迟结算)

class DamageQueue {
  head = 0;
  tail = 0;

  constructor(cap) {
    this.cap = cap;
    this.dueTick = new Int32Array(cap);
    this.tIdx = new Int32Array(cap);
    this.tId = new Int32Array(cap);
    this.dmg = new Float32Array(cap);
    this.isAoe = new Uint8Array(cap);
    this.ax = new Float32Array(cap);
    this.az = new Float32Array(cap);
    this.aTeam = new Uint8Array(cap);
    this.aR = new Float32Array(cap);
  }
  push(dueTick, targetIdx, targetId, dmg) {
    if (this.tail - this.head >= this.cap) return false;
    const i = this.tail++ % this.cap;
    this.dueTick[i] = dueTick;
    this.tIdx[i] = targetIdx;
    this.tId[i] = targetId;
    this.dmg[i] = dmg;
    this.isAoe[i] = 0;
    return true;
  }
  pushAoe(dueTick, x, z, team, dmg, radius) {
    if (this.tail - this.head >= this.cap) return false;
    const i = this.tail++ % this.cap;
    this.dueTick[i] = dueTick;
    this.dmg[i] = dmg;
    this.isAoe[i] = 1;
    this.ax[i] = x;
    this.az[i] = z;
    this.aTeam[i] = team;
    this.aR[i] = radius;
    return true;
  }
  kill(i, state, events) {
    state.state[i] = 2;
    events.push(EV.DEATH, state.posX[i], state.posZ[i], state.heading[i], state.team[i], state.kind[i]);
  }
  resolve(tick, state, grid, events) {
    while (this.head < this.tail) {
      const i = this.head % this.cap;
      if (this.dueTick[i] > tick) break;
      this.head++;
      if (this.isAoe[i]) {
        // AOE:落点周围按距离线性衰减(中心全额,边缘 30%)
        const r = this.aR[i];
        const r2 = r * r;
        const x = this.ax[i];
        const z = this.az[i];
        const reach = Math.ceil(r / CONFIG.gridCell);
        const cx = grid.cellX(x);
        const cz = grid.cellZ(z);
        for (let oz = -reach; oz <= reach; oz++)
          for (let ox = -reach; ox <= reach; ox++) {
            const c = (cz + oz) * grid.cellsX + (cx + ox);
            if (c < 0 || c >= grid.nCells) continue;
            for (let k = grid.cellStart[c]; k < grid.cellStart[c + 1]; k++) {
              const j = grid.indices[k];
              if (state.team[j] === this.aTeam[i] || state.state[j] === 2) continue;
              const dx = state.posX[j] - x;
              const dz = state.posZ[j] - z;
              const d2 = dx * dx + dz * dz;
              if (d2 > r2) continue;
              state.hp[j] -= this.dmg[i] * (1 - (0.7 * Math.sqrt(d2)) / r);
              if (state.hp[j] <= 0) this.kill(j, state, events);
            }
          }
        continue;
      }
      // 单体:索引可能因 swap-remove 失效,先校验 id,不符则线性找回
      let t = this.tIdx[i];
      if (t >= state.count || state.ids[t] !== this.tId[i]) {
        t = -1;
        for (let j = 0; j < state.count; j++)
          if (state.ids[j] === this.tId[i]) {
            t = j;
            break;
          }
      }
      if (t < 0 || state.state[t] === 2) continue;
      state.hp[t] -= this.dmg[i];
      if (state.hp[t] <= 0) this.kill(t, state, events);
    }
  }
}

// ---------------------------------------------------------------- 开火

// 冷却就绪 + 炮口对准(±0.25 rad)即开火:伤害按弹道飞行时间入队延迟结算,
// 同时向渲染端发射事件(巨炮/火箭走 AOE 弹道,磁轨/无人机/普通各有事件类型)。
function fireAndResolve(state, grid, dmgQueue, events, tick, rng) {
  const { posX, posZ, turretYaw, state: st, cooldown, recoil } = state;
  for (let i = 0; i < state.count; i++) {
    if (st[i] === 2) continue;
    if (recoil[i] > 0) {
      recoil[i] *= 0.55;
      if (recoil[i] < 0.04) recoil[i] = 0;
    }
    if (cooldown[i] > 0) cooldown[i]--;
    if (st[i] !== 1 || cooldown[i] > 0 || !state.hasValidTarget(i)) continue;
    const t = state.targetIdx[i];
    const dx = posX[t] - posX[i];
    const dz = posZ[t] - posZ[i];
    const d2 = dx * dx + dz * dz;
    const kind = state.kind[i];
    const stats = KIND_STATS[kind];
    if (d2 > stats.range * stats.range || Math.abs(wrapAngle(Math.atan2(dz, dx) - turretYaw[i])) > 0.25) continue;
    const flightTicks = Math.max(1, Math.ceil(Math.sqrt(d2) / stats.projSpeed / TICK_DT));
    cooldown[i] = stats.cooldown + (rng.u32() & 7);
    recoil[i] = 1;
    const mx = posX[i] + Math.cos(turretYaw[i]) * stats.muzzle;
    const mz = posZ[i] + Math.sin(turretYaw[i]) * stats.muzzle;
    if (stats.aoe > 0)
      for (let v = 0; v < stats.volley; v++) {
        const sx = stats.volley > 1 ? rng.range(-5, 5) : 0;
        const sz = stats.volley > 1 ? rng.range(-5, 5) : 0;
        const due = flightTicks + v * 3; // 齐射逐发错时
        dmgQueue.pushAoe(tick + due, posX[t] + sx, posZ[t] + sz, state.team[i], stats.damage, stats.aoe);
        events.push(kind === 1 ? EV.GSHOT : EV.RSHOT, mx, mz, posX[t] + sx, posZ[t] + sz, due * TICK_DT);
      }
    else {
      dmgQueue.push(tick + flightTicks, t, state.targetId[i], stats.damage);
      const evType = kind === 4 ? EV.BEAM : kind === 5 ? EV.DSHOT : EV.SHOT;
      events.push(evType, mx, mz, posX[t], posZ[t], flightTicks * TICK_DT);
    }
  }
  dmgQueue.resolve(tick, state, grid, events);
}

// 倒序清扫已死单位(swap-remove 保证只搬一次)
function sweepDead(state) {
  for (let i = state.count - 1; i >= 0; i--) if (state.state[i] === 2) state.kill(i);
}

const NULL_EVENTS = { push: () => true };

// ---------------------------------------------------------------- 模拟主体

class Simulation {
  tick = 0;
  stats = { grid: 0, flow: 0, steer: 0, collide: 0, combat: 0, total: 0 };

  constructor({ red, blue, seed, events }) {
    this.state = new UnitState(CONFIG.maxUnits);
    this.rng = makeRng(seed);
    this.map = generateObstacles(seed);
    this.sdf = new ObstacleSdf(GRID_W, GRID_H, CONFIG.gridCell, this.map.blocked);
    this.grid = new SpatialGrid(CONFIG.mapW, CONFIG.mapH, CONFIG.gridCell, CONFIG.maxUnits);
    // 占据网格(4m) 2×2 降采样到流场网格(8m):四格全堵才算堵
    const fw = Math.ceil(CONFIG.mapW / CONFIG.flowCell);
    const fh = Math.ceil(CONFIG.mapH / CONFIG.flowCell);
    const flowBlocked = new Uint8Array(fw * fh);
    for (let z = 0; z < fh; z++)
      for (let x = 0; x < fw; x++) {
        const gx = x * 2;
        const gz = z * 2;
        flowBlocked[z * fw + x] =
          this.map.blocked[gz * GRID_W + gx] &
          this.map.blocked[gz * GRID_W + gx + 1] &
          this.map.blocked[(gz + 1) * GRID_W + gx] &
          this.map.blocked[(gz + 1) * GRID_W + gx + 1];
      }
    this.flowCost = buildFlowCost(flowBlocked, this.sdf, fw, fh, CONFIG.flowCell);
    this.flow = [new FlowField(fw, fh, CONFIG.flowCell), new FlowField(fw, fh, CONFIG.flowCell)];
    this.srcX = new Float32Array(CONFIG.maxUnits);
    this.srcZ = new Float32Array(CONFIG.maxUnits);
    this.events = events ?? null;
    this.dmgQueue = new DamageQueue(65536);
    this.state.spawnArmies(red, blue, this.rng);
    this.refreshFlow(0);
    this.refreshFlow(1);
  }

  rebuildFlow() {
    this.refreshFlow(0);
    this.refreshFlow(1);
  }

  // team 的流场以"全体敌军位置"为源:沿场下降即冲向最近敌群
  refreshFlow(team) {
    const s = this.state;
    let n = 0;
    const enemy = +(team === 0);
    for (let i = 0; i < s.count; i++)
      if (s.team[i] === enemy && s.state[i] !== 2) {
        this.srcX[n] = s.posX[i];
        this.srcZ[n] = s.posZ[i];
        n++;
      }
    if (n > 0) this.flow[team].compute(this.flowCost, this.srcX, this.srcZ, n);
  }

  step() {
    const s = this.state;
    const t0 = performance.now();
    this.tick++;
    let t = performance.now();
    this.grid.build(s.posX, s.posZ, s.count);
    this.stats.grid = performance.now() - t;
    t = performance.now();
    // 两队流场错开半周期刷新,摊平峰值
    if (this.tick % CONFIG.flowRefreshTicks === 0) this.refreshFlow(0);
    if (this.tick % CONFIG.flowRefreshTicks === CONFIG.flowRefreshTicks >> 1) this.refreshFlow(1);
    this.stats.flow = performance.now() - t;
    t = performance.now();
    steer(s, this.grid, this.sdf, this.flow);
    this.stats.steer = performance.now() - t;
    t = performance.now();
    resolveCollisions(s, this.grid, this.sdf, 2);
    this.stats.collide = performance.now() - t;
    t = performance.now();
    retarget(s, this.grid, this.flow, this.tick % CONFIG.retargetBuckets);
    fireAndResolve(s, this.grid, this.dmgQueue, this.events ?? NULL_EVENTS, this.tick, this.rng);
    sweepDead(s);
    this.stats.combat = performance.now() - t;
    this.stats.total = performance.now() - t0;
  }

  // 写出一帧快照(布局见 protocol.js),并把当前态滚动为 prev
  publish(snap) {
    const s = this.state;
    const count = s.count;
    for (let i = 0; i < count; i++) {
      const o = i * SNAP_STRIDE;
      snap[o] = s.prevX[i];
      snap[o + 1] = s.prevZ[i];
      snap[o + 2] = s.prevHeading[i];
      snap[o + 3] = s.prevTurretYaw[i];
      snap[o + 4] = s.posX[i];
      snap[o + 5] = s.posZ[i];
      snap[o + 6] = s.heading[i];
      snap[o + 7] = s.turretYaw[i];
      snap[o + 8] = s.team[i] + s.kind[i] * 2 + (s.ids[i] & 63) / 256 + (s.selected[i] ? 0.5 : 0);
      snap[o + 9] = Math.round((s.hp[i] / KIND_STATS[s.kind[i]].hp) * 31) + Math.min(s.recoil[i], 0.96);
    }
    s.prevX.set(s.posX.subarray(0, count));
    s.prevZ.set(s.posZ.subarray(0, count));
    s.prevHeading.set(s.heading.subarray(0, count));
    s.prevTurretYaw.set(s.turretYaw.subarray(0, count));
    return count;
  }

  aliveByTeam() {
    let red = 0;
    let blue = 0;
    for (let i = 0; i < this.state.count; i++) this.state.team[i] === 0 ? red++ : blue++;
    return [red, blue];
  }

  // 两军质心间距(诊断用)
  armyGap() {
    let rx = 0;
    let rn = 0;
    let bx = 0;
    let bn = 0;
    const s = this.state;
    for (let i = 0; i < s.count; i++)
      if (s.team[i] === 0) {
        rx += s.posX[i];
        rn++;
      } else {
        bx += s.posX[i];
        bn++;
      }
    return Math.abs(bx / Math.max(bn, 1) - rx / Math.max(rn, 1));
  }
}

// ---------------------------------------------------------------- 指挥命令

// 框选:四边形叉积判内,只保留入选数多的一方(避免误选敌军)
function applySelection(state, quad) {
  state.selected.fill(0, 0, state.count);
  if (quad.length < 8) return;
  const teamCount = [0, 0];
  const inside = new Uint8Array(state.count);
  for (let i = 0; i < state.count; i++) {
    const x = state.posX[i];
    const z = state.posZ[i];
    let pos = 0;
    let neg = 0;
    for (let e = 0; e < 4; e++) {
      const x0 = quad[e * 2];
      const z0 = quad[e * 2 + 1];
      const x1 = quad[((e + 1) & 3) * 2];
      const z1 = quad[((e + 1) & 3) * 2 + 1];
      (x1 - x0) * (z - z0) - (z1 - z0) * (x - x0) >= 0 ? pos++ : neg++;
    }
    if (pos === 4 || neg === 4) {
      inside[i] = 1;
      teamCount[state.team[i]]++;
    }
  }
  const team = teamCount[0] >= teamCount[1] ? 0 : 1;
  for (let i = 0; i < state.count; i++) if (inside[i] && state.team[i] === team) state.selected[i] = 1;
}

// 移动命令:保持相对队形(以选中群质心为参考,过远的收拢到半径内)
function applyMoveOrder(state, x, z) {
  let n = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < state.count; i++)
    if (state.selected[i]) {
      n++;
      cx += state.posX[i];
      cz += state.posZ[i];
    }
  if (n === 0) return;
  cx /= n;
  cz /= n;
  const maxR = Math.max(10, Math.sqrt(n) * 1.4);
  for (let i = 0; i < state.count; i++) {
    if (!state.selected[i]) continue;
    const ox = state.posX[i] - cx;
    const oz = state.posZ[i] - cz;
    const d = Math.hypot(ox, oz);
    const k = d > maxR ? maxR / d : 1;
    state.orderX[i] = Math.min(Math.max(x + ox * k, 6), CONFIG.mapW - 6);
    state.orderZ[i] = Math.min(Math.max(z + oz * k, 6), CONFIG.mapH - 6);
    state.order[i] = 1;
  }
}

// ---------------------------------------------------------------- Worker 主循环

let views; // SAB(或本地缓冲)上的协议视图
let sim;
let restartSeen = 0;
let redCount = CONFIG.defaultRed;
let blueCount = CONFIG.defaultBlue;
let seed = CONFIG.seed;
let mode = 'sab'; // 'sab' 零拷贝 | 'copy' Transferable 乒乓
let returnBuf = null; // copy 模式下主线程归还的缓冲
let emaMs = 0;

function makeSim() {
  return new Simulation({
    red: redCount,
    blue: blueCount,
    seed,
    events: new EventWriter(views.evHead, views.evI32, views.evF32, CONFIG.eventCapacity, views.header),
  });
}

function tickLoop() {
  const speed = views.header[HEADER.SPEED_X100] / 100;
  // 主线程通过 header 请求重开(免 postMessage 往返)
  if (views.header[HEADER.REQ_RESTART] !== restartSeen) {
    restartSeen = views.header[HEADER.REQ_RESTART];
    redCount = Math.min(Math.max(views.header[HEADER.REQ_RED], 1), CONFIG.maxUnits - 1);
    blueCount = Math.min(Math.max(views.header[HEADER.REQ_BLUE], 1), CONFIG.maxUnits - redCount);
    Atomics.store(views.evHead, 0, 0);
    Atomics.store(views.evHead, 1, 0);
    views.header[HEADER.EV_DROPPED] = 0;
    sim = makeSim();
    views.header[HEADER.RESTART_ACK] = restartSeen;
  }
  const t0 = performance.now();
  if (speed > 0) {
    sim.step();
    const back = 1 - views.header[HEADER.FRONT];
    const count = sim.publish(views.snaps[back]);
    const [red, blue] = sim.aliveByTeam();
    views.header[HEADER.COUNT] = count;
    views.header[HEADER.ALIVE_RED] = red;
    views.header[HEADER.ALIVE_BLUE] = blue;
    views.header[HEADER.FRONT] = back; // 写完才翻页,渲染端永远读到完整帧
    Atomics.store(views.header, HEADER.TICK, sim.tick);
    if (mode === 'copy') flushCopySnapshot();
  }
  const elapsed = performance.now() - t0;
  views.header[HEADER.SIM_MS_X100] = Math.round(elapsed * 100);
  if (sim.tick % 30 === 0) self.postMessage({ kind: 'sim-stats', stats: { ...sim.stats } });
  emaMs = emaMs * 0.9 + elapsed * 0.1;
  // 过载时自动放宽 tick 间隔(至 2 倍),speed 倍率反向缩短
  const load = Math.min(Math.max(emaMs / ((1e3 / CONFIG.simHz) * 0.8), 1), 2);
  const interval = ((1e3 / CONFIG.simHz) * load) / Math.max(speed, 0.25);
  setTimeout(tickLoop, Math.max(0, interval - elapsed));
}

// copy 模式:把整块状态复制进归还缓冲,Transferable 传给主线程
function flushCopySnapshot() {
  if (!returnBuf) return;
  const buf = returnBuf;
  returnBuf = null;
  new Uint8Array(buf).set(new Uint8Array(views.header.buffer));
  Atomics.store(views.evHead, 1, Atomics.load(views.evHead, 0)); // 事件随快照带走,本地标记已读
  self.postMessage({ kind: 'snapshot', buf }, [buf]);
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.kind === 'init-sab') {
    mode = 'sab';
    views = makeViews(msg.sab, CONFIG.maxUnits, CONFIG.eventCapacity);
    redCount = msg.red;
    blueCount = msg.blue;
    seed = msg.seed;
    views.header[HEADER.SPEED_X100] = 100;
    sim = makeSim();
    tickLoop();
    self.postMessage({ ready: true });
  } else if (msg.kind === 'init-copy') {
    mode = 'copy';
    const total = sabLayout(CONFIG.maxUnits, CONFIG.eventCapacity).total;
    views = makeViews(new ArrayBuffer(total), CONFIG.maxUnits, CONFIG.eventCapacity);
    returnBuf = new ArrayBuffer(total);
    redCount = msg.red;
    blueCount = msg.blue;
    seed = msg.seed;
    views.header[HEADER.SPEED_X100] = 100;
    sim = makeSim();
    tickLoop();
    self.postMessage({ ready: true });
  } else if (msg.kind === 'cmd') {
    const cmd = msg.cmd;
    if (cmd.speedX100 !== undefined) views.header[HEADER.SPEED_X100] = cmd.speedX100;
    if (cmd.restart) {
      views.header[HEADER.REQ_RED] = cmd.restart.red;
      views.header[HEADER.REQ_BLUE] = cmd.restart.blue;
      views.header[HEADER.REQ_RESTART]++;
    }
  } else if (msg.kind === 'return') returnBuf = msg.buf;
  else if (msg.kind === 'select') sim && applySelection(sim.state, msg.quad);
  else if (msg.kind === 'move') sim && applyMoveOrder(sim.state, msg.x, msg.z);
};

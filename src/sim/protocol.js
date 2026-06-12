// 主线程 ⇄ 模拟 Worker 的共享内存协议。
//
// 缓冲区布局(SharedArrayBuffer 或降级时的普通 ArrayBuffer):
//   [Int32 header | 快照 A | 快照 B | Int32 事件头(写/读游标) | 事件环形缓冲]
// 快照双缓冲:Worker 写完一帧后翻转 FRONT,渲染端总是读 front 快照,无锁。
//
// 单位快照记录 = SNAP_STRIDE 个 float:
//   [0..3] 上一 tick 的 x, z, 车体朝向, 炮塔朝向   (渲染端两帧插值的起点)
//   [4..7] 当前 tick 的 x, z, 车体朝向, 炮塔朝向
//   [8]    meta  = team + kind*2 + (id&63)/256 + (选中 ? 0.5 : 0)   位打包
//   [9]    hpRecoil = round(hp/maxHp*31) 整数部分 + min(后坐力,0.96) 小数部分
//
// 事件记录 = EV_STRIDE 个 32 位槽,槽 0 是 Int32 事件类型,其余为 Float32,
// 含义随类型而变(发射点/落点/飞行时间或死亡兵种等),见 battle/main.js 的消费端。

export const HEADER = {
  TICK: 0,
  FRONT: 1,        // 当前可读快照页 (0/1)
  COUNT: 2,        // 单位总数(含已死,按 id 紧凑排列前 aliveCount 个)
  ALIVE_RED: 3,
  ALIVE_BLUE: 4,
  SIM_MS_X100: 5,  // 每 tick 模拟耗时 ×100,诊断用
  SPEED_X100: 6,   // 模拟速度倍率 ×100,主线程写入
  REQ_RED: 7,      // 重开请求的兵力数,配合 REQ_RESTART
  REQ_BLUE: 8,
  REQ_RESTART: 9,
  RESTART_ACK: 10,
  EV_DROPPED: 11,  // 事件环溢出丢弃计数
  SIZE: 16,
};

// 事件类型(事件记录槽 0)
export const EV = {
  SHOT: 1,   // 普通直射: 炮口 x,z → 落点 x,z, 飞行时间
  DEATH: 2,  // 死亡: x, z, 朝向, -, 兵种
  GSHOT: 3,  // 巨炮 AOE 射击
  RSHOT: 4,  // 火箭弹(抛物线)
  BEAM: 5,   // 磁轨光束
  DSHOT: 6,  // 无人机俯射
};

export const SNAP_STRIDE = 10; // float / 单位
export const EV_STRIDE = 6;    // 32 位槽 / 事件

// 计算总缓冲尺寸与各段偏移(字节)
export function sabLayout(maxUnits, eventCapacity) {
  const headerBytes = HEADER.SIZE * 4;
  const snapBytes = maxUnits * SNAP_STRIDE * 4;
  const snap1 = headerBytes + snapBytes;
  const evHead = snap1 + snapBytes;
  const ev = evHead + 8;
  return {
    total: ev + eventCapacity * EV_STRIDE * 4,
    offsets: { header: 0, snap0: headerBytes, snap1, evHead, ev },
  };
}

// 在给定缓冲上建立各段类型化视图
export function makeViews(buffer, maxUnits, eventCapacity) {
  const o = sabLayout(maxUnits, eventCapacity).offsets;
  return {
    header: new Int32Array(buffer, o.header, HEADER.SIZE),
    snaps: [
      new Float32Array(buffer, o.snap0, maxUnits * SNAP_STRIDE),
      new Float32Array(buffer, o.snap1, maxUnits * SNAP_STRIDE),
    ],
    evHead: new Int32Array(buffer, o.evHead, 2), // [写游标, 读游标]
    evI32: new Int32Array(buffer, o.ev, eventCapacity * EV_STRIDE),
    evF32: new Float32Array(buffer, o.ev, eventCapacity * EV_STRIDE),
  };
}

// 事件环写入端(Worker 侧):环满时丢弃并计数,绝不阻塞模拟
export class EventWriter {
  constructor(evHead, evI32, evF32, capacity, header) {
    this.head = evHead;
    this.i32 = evI32;
    this.f32 = evF32;
    this.cap = capacity;
    this.header = header;
  }
  push(type, a, b, c, d, e) {
    const write = Atomics.load(this.head, 0);
    if (write - Atomics.load(this.head, 1) >= this.cap) {
      this.header[HEADER.EV_DROPPED]++;
      return false;
    }
    const o = (write % this.cap) * EV_STRIDE;
    this.i32[o] = type;
    this.f32[o + 1] = a;
    this.f32[o + 2] = b;
    this.f32[o + 3] = c;
    this.f32[o + 4] = d;
    this.f32[o + 5] = e;
    Atomics.store(this.head, 0, write + 1);
    return true;
  }
}

// 事件环读取端:把 [读游标, 写游标) 间的事件逐条回调后推进读游标
export class EventReader {
  constructor(evHead, evI32, evF32, capacity) {
    this.head = evHead;
    this.i32 = evI32;
    this.f32 = evF32;
    this.cap = capacity;
  }
  drain(fn) {
    let read = Atomics.load(this.head, 1);
    const write = Atomics.load(this.head, 0);
    while (read < write) {
      const o = (read % this.cap) * EV_STRIDE;
      fn(this.i32[o], this.f32[o + 1], this.f32[o + 2], this.f32[o + 3], this.f32[o + 4], this.f32[o + 5]);
      read++;
    }
    Atomics.store(this.head, 1, read);
  }
}

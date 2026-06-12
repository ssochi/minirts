# 架构

## 总体数据流

```
┌─────────────────── Worker (sim.worker.js, 15Hz) ───────────────────┐
│ 空间哈希重建 → 流场刷新(两队错开半周期) → 转向 → 碰撞×2 →          │
│ 分桶索敌 → 开火(伤害按飞行时间入队) → 延迟结算 → 清尸 → 发布快照   │
└──────────────┬─────────────────────────────────────────────────────┘
               │ SharedArrayBuffer(或 Transferable 乒乓)
   ┌───────────▼───────────────────────────────────────────┐
   │ [Int32 header | 快照A | 快照B | 事件头 | 事件环×4096] │
   └───────────┬───────────────────────────────────────────┘
               │ 每帧轮询 TICK,变化才消费
┌──────────────▼────────── 主线程 (battle/main.js, rAF) ──────────────┐
│ 快照上传 FleetRenderer(远/近分拣) → 事件环 drain → 特效池 spawn →   │
│ 帧内插值 setFrame(α) → 太阳影随焦点 → flush 各池 → 渲染            │
└─────────────────────────────────────────────────────────────────────┘
```

模拟与渲染唯一的耦合点是 `src/sim/protocol.js` 定义的缓冲布局与
`src/core/config.js` 的参数表——两端从同一模块导入,且用同一种子
(`CONFIG.seed`)独立重建同一张障碍地图(`src/world/map-gen.js`)。

## 协议(src/sim/protocol.js)

- **header**(Int32×16):TICK/FRONT(可读页)/COUNT/双方存活数/模拟耗时/
  速度倍率/重开请求三元组/事件丢弃计数。SAB 模式下主线程直接写 header
  下命令,免 postMessage 往返。
- **快照**(双缓冲,每单位 10×f32):`[prevX, prevZ, prevHeading, prevTurretYaw,
  x, z, heading, turretYaw, meta, hpRecoil]`。Worker 写完页才翻 FRONT,
  渲染端永远读到完整帧(无锁)。
  - `meta = team + kind*2 + (id&63)/256 + (selected?0.5:0)` —— 着色器内位解包
  - `hpRecoil = round(hp/maxHp*31) + min(recoil,0.96)` —— 整数部分血量档,小数部分后坐力
- **事件环**(4096×6 槽):SHOT/DEATH/GSHOT(巨炮)/RSHOT(火箭)/BEAM(磁轨)/
  DSHOT(无人机)。写满即丢(EV_DROPPED 计数),绝不阻塞模拟。

## 模拟(src/sim/sim.worker.js)

- **SoA 单位状态**:全部 TypedArray,死亡用 swap-remove;目标引用存
  `(targetIdx, targetId)` 双份,索引串号由 id 校验兜底。
- **空间哈希**:计数排序桶(cellStart/indices),无链表无分配。
- **障碍 SDF**:两遍 chamfer 距离变换;转向避墙与碰撞推出都用其梯度。
- **流场**:8m 网格,以全体敌军为源的多源 Dijkstra(二叉堆),代价场
  对贴墙格 ×6 引导大军绕开瓶颈;每格取最陡下降邻居为方向。
  两队各一张,错开半周期每 4 tick 刷新。
- **兵种行为**(数值见 config.js):侦察车 hit&run(冷却期掉头脱离)、
  磁轨/火箭炮 kite(敌近倒车保距)、无人机飞行(不参与地面碰撞/避墙)、
  低血(<28%)强制脱离。
- **自适应调度**:tick 耗时 EMA 超过预算的 80% 时间隔放宽至 2 倍;
  HUD 速度倍率反向缩短间隔。

## 渲染

- **FleetRenderer**(render/fleet-renderer.js):远/近两档实例化。
  焦点 150m 内 + 视锥地面四边形(35m 余量)内的单位进近档(高模、
  铰接炮塔、阴影投射),其余进远档(低模合并网格)。顶点动画全在
  GPU:履带 UV 滚动、负重轮自转、旋翼旋转由顶点 color/aAnim 通道驱动,
  后坐力从 hpRecoil 小数部分解出。
- **贴图集**(render/atlas/):`PixelPainter` 在 512² 画布上程序化手绘
  19 种装甲瓦片(板甲/履带/负重轮/炮管/格栅/舱盖/警示条…),
  `tileBox/tileCylinder` 把瓦片矩形写进 aTile 顶点属性,片元按其在
  图集内寻址。六兵种共用一张 DataTexture,零外部资源。
- **GroundFlashMap**(render/ground-flash-map.js):256×144 HalfFloat RT,
  地图空间。炮口闪光/爆炸作为短寿命径向光点加性溅射,地面、车体、
  残骸、碎片着色器统一采样 —— "战场被炮火照亮"的关键。
- **特效池**(render/fx/):全部环形缓冲 + 实例化 + dirty-range 上传,
  spawn 是纯数组写入,无对象分配。粒子 kind:0 尘土/1 炮口焰/2 火球/
  3 烟/4 巨炮弹道(重力弧)/5 磁轨弹。死亡时残骸(低模车体染黑)与
  碎片(炮塔/装甲板/负重轮/履带四池)接管尸体表现。
- **海量限流**:特效按 `22500/d²` 概率随焦点距离抽样(150m 内必播),
  行进尘土每帧只抽 ~256 个单位,残骸冒烟 0.45s 节流。

## 还原约定

- 跨模块命名契约见 `.work/GLOSSARY.md`(工作目录,未入库)。
- GLSL/CSS/HTML 模板字符串中的中文注释为原作者所写,逐字保留。
- 原版把 BufferGeometryUtils 的 `mergeGeometries` 拷进了 bundle,
  还原后改为 `three/addons` 导入;内嵌 Worker 字符串还原为标准的
  `new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' })`,
  其内联复制的 config/protocol/rng/map-gen 改为共享模块导入
  (打包时 Vite 会重新内联,产物等价)。

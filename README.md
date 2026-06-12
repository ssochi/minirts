# 海量坦克对战 (Massive Tank Battle)

3 万 vs 3 万实时会战:框选指挥、巨炮 AOE、六兵种合成军协同。
Three.js 渲染 + Web Worker 权威模拟,SharedArrayBuffer 零拷贝快照通道。

| 模式 | 入口 | 说明 |
|---|---|---|
| ⚔ 对战 | `/`(默认) | 双方各至多 65536 单位的全自动会战,玩家可框选/移动指挥 |
| 🔍 单位预览 | `/#preview` | 逐一检阅六大兵种:模型细节、炮塔动画、开火特效与后坐 |

## 快速开始

```bash
npm install
npm run dev      # 开发(自动注入 COOP/COEP 头,启用 SharedArrayBuffer)
npm run build    # 产物在 dist/
npm run preview  # 本地预览构建产物
```

> 部署注意:要走 SharedArrayBuffer 零拷贝快路径,服务器需返回
> `Cross-Origin-Opener-Policy: same-origin` 与 `Cross-Origin-Embedder-Policy: require-corp`。
> 没有这两个头时游戏自动降级为复制通道(Transferable 乒乓),功能完整,仅多一次内存拷贝。

## 操作

- **左键拖拽** 框选(自动只选多数方);**右键** 移动命令;**单击** 清选
- **WASD/中键** 平移、**滚轮/JK** 缩放、**QE** 旋转、**F** 随机跟随一辆
- **P** 性能诊断面板(各渲染系统可逐项消融)

## 目录结构

```
src/
├── main.js            入口:hash 路由 + 模式菜单 + 致命错误兜底
├── core/              config(模拟参数/兵种数值表)、种子 RNG
├── world/             地形高度场、障碍地图生成、天穹、地面
├── sim/               模拟侧:协议(SAB 布局/事件环)、通道协商、Worker 本体
├── models/            六兵种程序化几何(车体+炮塔,高/低两档 LOD)
├── render/            车队实例化渲染器、手绘贴图集、地面光斑图、特效池
│   ├── atlas/         像素画笔 + 512² 装甲贴图集(19 种瓦片)
│   └── fx/            粒子/曳光/辉光/冲击波/残骸/碎片
├── ui/                RTS 相机、HUD、性能诊断
├── battle/            对战模式主循环(快照插值 + 事件分发特效)
└── preview/           单位预览模式
```

架构细节(数据流、协议布局、渲染管线、性能设计)见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 关键设计

- **模拟/渲染分离**:Worker 以 15Hz 推进权威模拟,主线程每帧在双缓冲快照间插值,互不阻塞。
- **每单位 10 个 float**:位置/朝向双份(插值用)+ 位打包的 meta 与 hp/后坐力,6 万单位一帧快照仅 2.4MB。
- **流场寻路**:以全体敌军为源的多源 Dijkstra 距离场,大军沿场下降即冲向最近敌群,单位数与寻路开销解耦。
- **两档 LOD 实例化**:战场焦点 150m 内用高模(全细节+投影),其余全军低模+blob 阴影,6 万单位 17 个 draw call。
- **手绘贴图集**:512² 像素画程序生成(装甲板/履带/负重轮/警示条…),六兵种共享,零外部资源。

## 来源

本仓库由打包后的单文件 `index.html`(836KB,Vite/Rolldown 产物,内联 three.js r182
与压缩混淆的游戏代码)逆向还原而来。原始文件保存在 git 首个提交中:

```bash
git show $(git rev-list --max-parents=0 HEAD):index.html > original.html
```

还原原则:行为零改动(全部数值与运算顺序逐字保留),three.js 改为 npm 依赖,
模板字符串中幸存的原作者中文注释(GLSL/CSS/HTML)全部原样保留。

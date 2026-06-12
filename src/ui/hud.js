// HUD 顶栏:双方存活计数、统计行、规模输入 + 重开、速度切换、跟随按钮,
// 以及「操作介绍」帮助弹层。回调 onRestart/onSpeed/onFollow 由 battle/main.js 注入。
// frame() 每 500ms 聚合一次 fps 并刷新统计文本。

import { CONFIG } from '../core/config.js';
import { HEADER } from '../sim/protocol.js';

export const MAX_PER_SIDE = CONFIG.maxUnits / 2;

// 钳制规模输入框:取整并限制到 [1, MAX_PER_SIDE],非数字回落为 10000,同时回写输入框
export function clampArmyInput(inputEl) {
  const raw = Math.round(Number(inputEl.value));
  const n = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), MAX_PER_SIDE) : 1e4;
  inputEl.value = String(n);
  return n;
}

export class Hud {
  el = document.getElementById(`hud`);
  stats;
  fpsAcc = 0;
  fps = 0;
  lastT = 0;
  onRestart = () => {};
  onSpeed = () => {};
  onFollow = () => {};

  constructor() {
    this.el.innerHTML = `
      <div class="panel"><span class="red" id="h-red">0</span> vs <span class="blue" id="h-blue">0</span></div>
      <div class="panel" id="h-stats"></div>
      <div class="panel">
        规模 <span class="red">红</span> <input id="h-size-red" type="number" min="1" max="${MAX_PER_SIDE}" step="1000" value="${CONFIG.defaultRed}" />
        <span class="blue">蓝</span> <input id="h-size-blue" type="number" min="1" max="${MAX_PER_SIDE}" step="1000" value="${CONFIG.defaultBlue}" />
        <button id="h-restart">重开</button>
        <span style="opacity:.6">(每边 ≤${MAX_PER_SIDE})</span><br/>
        速度 <button data-s="0">⏸</button><button data-s="100" class="on">1×</button>
        <button data-s="200">2×</button><button data-s="400">4×</button>
        <button id="h-follow">跟随(F)</button>
        <button id="h-help">操作介绍</button>
      </div>`;
    this.buildHelp();
    this.stats = document.getElementById(`h-stats`);
    document.getElementById(`h-restart`).addEventListener(`click`, () => {
      const red = clampArmyInput(document.getElementById(`h-size-red`));
      const blue = clampArmyInput(document.getElementById(`h-size-blue`));
      this.onRestart(red, blue);
    });
    this.el.querySelectorAll(`button[data-s]`).forEach((btn) =>
      btn.addEventListener(`click`, () => {
        this.el.querySelectorAll(`button[data-s]`).forEach((b) => b.classList.remove(`on`));
        btn.classList.add(`on`);
        this.onSpeed(Number(btn.dataset.s));
      }),
    );
    document.getElementById(`h-follow`).addEventListener(`click`, () => this.onFollow());
  }

  // 帮助弹层:点遮罩 / 关闭按钮 / Esc 均可关闭
  buildHelp() {
    const overlay = document.createElement(`div`);
    overlay.id = `help`;
    overlay.innerHTML = `
      <div class="card">
        <button class="close" aria-label="关闭">×</button>
        <h2>操作介绍</h2>
        <table>
          <tr><td>左键拖拽</td><td>框选单位(单击空地取消选择)</td></tr>
          <tr><td>右键</td><td>命令选中单位移动到落点(边走边打)</td></tr>
          <tr><td>中键拖拽 / W A S D</td><td>平移视角</td></tr>
          <tr><td>滚轮 / J K</td><td>缩放(按住持续)</td></tr>
          <tr><td>Q / E</td><td>旋转视角</td></tr>
          <tr><td>F 或「跟随」按钮</td><td>跟随一个随机单位,再按取消</td></tr>
          <tr><td>规模输入 + 重开</td><td>红 / 蓝兵力自定义(每边 1~65536)</td></tr>
          <tr><td>速度按钮</td><td>暂停 / 1× / 2× / 4×</td></tr>
        </table>
        <h2>兵种速览</h2>
        <table>
          <tr><td>主战坦克</td><td>中坚战线,站桩对射</td></tr>
          <tr><td>侦察车</td><td>高速先锋,打了就跑</td></tr>
          <tr><td>攻击无人机</td><td>飞行掠袭,越障俯射</td></tr>
          <tr><td>磁轨歼击车</td><td>远程重击,敌近倒车保距</td></tr>
          <tr><td>火箭炮车</td><td>六连齐射小范围覆盖</td></tr>
          <tr><td>巨型坦克</td><td>压阵巨炮,大范围 AOE</td></tr>
        </table>
        <p>轻装单位残血会自动脱离接触。两军全灭一方即分出胜负,「重开」可随时再战。</p>
      </div>`;
    document.body.appendChild(overlay);
    // force 省略时取反当前显示状态
    const toggle = (force) => {
      overlay.style.display = (force ?? overlay.style.display !== `grid`) ? `grid` : `none`;
    };
    document.getElementById(`h-help`).addEventListener(`click`, () => toggle());
    overlay.querySelector(`.close`).addEventListener(`click`, () => toggle(false));
    overlay.addEventListener(`click`, (e) => {
      e.target === overlay && toggle(false);
    });
    addEventListener(`keydown`, (e) => {
      e.key === `Escape` && toggle(false);
    });
  }

  frame(now, views, drawCalls, particleCount) {
    this.fpsAcc += 1;
    if (now - this.lastT > 500) {
      this.fps = Math.round((this.fpsAcc * 1e3) / (now - this.lastT));
      this.fpsAcc = 0;
      this.lastT = now;
      document.getElementById(`h-red`).textContent = String(views.header[HEADER.ALIVE_RED]);
      document.getElementById(`h-blue`).textContent = String(views.header[HEADER.ALIVE_BLUE]);
      this.stats.textContent = `fps ${this.fps} | tick ${(views.header[HEADER.SIM_MS_X100] / 100).toFixed(1)}ms | draw ${drawCalls} | fx/f ${particleCount} | evDrop ${views.header[HEADER.EV_DROPPED]}`;
    }
  }
}

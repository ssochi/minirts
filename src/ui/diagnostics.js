// 性能诊断面板(按 P 显隐):帧时 EMA + 90 帧中位数、CPU 各系统耗时(EMA)、
// Worker 模拟分相耗时、任意附加行,并用 EXT_disjoint_timer_query_webgl2 测整帧 GPU 时间。
// register() 登记的系统可在面板里逐个开关做消融;runAblation() 自动逐项关停采样出报告。

export class DiagnosticsOverlay {
  systems = [];
  cpuMs = new Map();
  frameMs = 0;
  samples = [];
  lastFrame = 0;
  el;
  gpu = null;
  simPhases = {};
  extra = {};
  report = null;

  constructor(renderer) {
    const gl = renderer.getContext();
    const ext = gl.getExtension(`EXT_disjoint_timer_query_webgl2`);
    this.gpu = { ext, gl, q: null, ms: -1 };
    this.el = document.createElement(`div`);
    this.el.id = `diag`;
    this.el.style.cssText = `position:fixed;left:8px;bottom:8px;z-index:25;background:rgba(8,12,18,.88);border:1px solid #2a3442;border-radius:6px;padding:8px 10px;font:11px/1.5 ui-monospace,Menlo,monospace;color:#cfd8e3;display:none;white-space:pre;pointer-events:auto;max-height:70vh;overflow-y:auto;`;
    document.body.appendChild(this.el);
    addEventListener(`keydown`, (e) => {
      e.target?.tagName !== `INPUT` &&
        e.key === `p` &&
        (this.el.style.display = this.el.style.display === `none` ? `block` : `none`);
    });
  }

  // 登记一个可消融系统:objs 为其全部 three 对象,统一切 visible
  register(name, objs) {
    this.systems.push({ name, objs });
  }

  // 包裹一段 CPU 工作并按 0.95/0.05 EMA 记账,返回原函数返回值
  time(name, fn) {
    const t0 = performance.now();
    const ret = fn();
    const ms = performance.now() - t0;
    this.cpuMs.set(name, (this.cpuMs.get(name) ?? ms) * 0.95 + ms * 0.05);
    return ret;
  }

  // GPU 计时:同一时刻只挂一个 query,先收上一帧结果(0.9/0.1 EMA)再开新查询
  gpuWrap(draw) {
    const gpu = this.gpu;
    if (!gpu.ext) {
      draw();
      return;
    }
    const gl = gpu.gl;
    const TIME_ELAPSED_EXT = 35007;
    if (gpu.q && gl.getQueryParameter(gpu.q, 34919 /* QUERY_RESULT_AVAILABLE */)) {
      const ns = gl.getQueryParameter(gpu.q, 34918 /* QUERY_RESULT */);
      gpu.ms = gpu.ms < 0 ? ns / 1e6 : gpu.ms * 0.9 + (ns / 1e6) * 0.1;
      gl.deleteQuery(gpu.q);
      gpu.q = null;
    }
    if (gpu.q) {
      draw();
    } else {
      gpu.q = gl.createQuery();
      gl.beginQuery(TIME_ELAPSED_EXT, gpu.q);
      draw();
      gl.endQuery(TIME_ELAPSED_EXT);
    }
  }

  // 每帧调用:累计帧间隔样本(保留最近 90 帧),每 500ms 且面板可见时重绘
  frame() {
    const now = performance.now();
    if (this.lastFrame > 0) {
      const dt = now - this.lastFrame;
      this.frameMs = this.frameMs === 0 ? dt : this.frameMs * 0.95 + dt * 0.05;
      this.samples.push(dt);
      this.samples.length > 90 && this.samples.shift();
    }
    this.lastFrame = now;
    ((now / 500) | 0) != (((now - 16) / 500) | 0) && this.el.style.display !== `none` && this.render();
  }

  median() {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  render() {
    const lines = [],
      med = this.median();
    lines.push(
      `帧时 ${this.frameMs.toFixed(1)}ms (中位 ${med.toFixed(1)} / ${(1e3 / Math.max(med, 0.01)).toFixed(0)}fps)`,
    );
    lines.push(
      `GPU ${this.gpu?.ext ? (this.gpu.ms >= 0 ? this.gpu.ms.toFixed(1) + `ms` : `等待`) : `不可用(ANGLE)`}`,
    );
    lines.push(`--- CPU 主线程(EMA) ---`);
    for (const [name, ms] of this.cpuMs) lines.push(`${name.padEnd(10)} ${ms.toFixed(2)}ms`);
    if (Object.keys(this.simPhases).length) {
      lines.push(`--- Worker 模拟(每 tick) ---`);
      for (const [name, ms] of Object.entries(this.simPhases)) lines.push(`${name.padEnd(10)} ${ms.toFixed(1)}ms`);
    }
    for (const [name, value] of Object.entries(this.extra)) lines.push(`${name} ${value}`);
    lines.push(`--- 消融(点击开关) ---`);
    this.el.textContent = lines.join(`\n`) + `\n`;
    for (const sys of this.systems) {
      const btn = document.createElement(`button`);
      btn.textContent = `${sys.objs[0]?.visible === false ? `☐` : `☑`} ${sys.name}`;
      btn.style.cssText = `display:inline-block;margin:1px;background:#1b2430;color:inherit;border:1px solid #2a3442;border-radius:4px;font:inherit;cursor:pointer;padding:1px 5px;`;
      btn.addEventListener(`click`, () => {
        const show = sys.objs[0]?.visible === false;
        for (const obj of sys.objs) obj.visible = show;
        this.render();
      });
      this.el.appendChild(btn);
    }
  }

  // 消融测试:基线采样 1.4s 后逐系统关停再采样,按帧时增量降序出报告
  async runAblation() {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const sample = async () => ((this.samples.length = 0), await sleep(1400), { med: this.median(), gpu: this.gpu?.ms ?? -1 });
    const base = await sample(),
      rows = [];
    for (const sys of this.systems) {
      for (const obj of sys.objs) obj.visible = false;
      const r = await sample();
      rows.push({ name: sys.name, medMs: r.med, deltaMs: base.med - r.med });
      for (const obj of sys.objs) obj.visible = true;
    }
    rows.sort((a, b) => b.deltaMs - a.deltaMs);
    this.report = {
      baselineMs: base.med,
      baselineFps: 1e3 / base.med,
      gpuMs: base.gpu,
      cpu: Object.fromEntries(this.cpuMs),
      sim: { ...this.simPhases },
      extra: { ...this.extra },
      ablation: rows,
    };
    return this.report;
  }
}

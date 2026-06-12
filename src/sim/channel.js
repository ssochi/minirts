// 主线程侧的模拟通道。优先 SharedArrayBuffer 零拷贝(需跨源隔离,见 vite.config.js
// 注入的 COOP/COEP 头);否则降级为复制通道:Worker 整块快照 Transferable 传来,
// 主线程用完把缓冲归还,两块缓冲乒乓复用,零分配。

import { CONFIG } from '../core/config.js';
import { HEADER, sabLayout, makeViews } from './protocol.js';

export function createSimWorker() {
  return new Worker(new URL('./sim.worker.js', import.meta.url), { type: 'module' });
}

export function createSimChannel(worker, red, blue, seed) {
  const total = sabLayout(CONFIG.maxUnits, CONFIG.eventCapacity).total;

  if (typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated) {
    const sab = new SharedArrayBuffer(total);
    const views = makeViews(sab, CONFIG.maxUnits, CONFIG.eventCapacity);
    worker.postMessage({ kind: 'init-sab', sab, red, blue, seed });
    return {
      views,
      mode: 'sab',
      // SAB 模式下命令直接写共享 header,免 postMessage 往返
      sendCommand(cmd) {
        if (cmd.speedX100 !== undefined) views.header[HEADER.SPEED_X100] = cmd.speedX100;
        if (cmd.restart) {
          views.header[HEADER.REQ_RED] = cmd.restart.red;
          views.header[HEADER.REQ_BLUE] = cmd.restart.blue;
          views.header[HEADER.REQ_RESTART]++;
        }
      },
      sendSelect(quad) {
        worker.postMessage({ kind: 'select', quad });
      },
      sendMove(x, z) {
        worker.postMessage({ kind: 'move', x, z });
      },
    };
  }

  const channel = {
    views: makeViews(new ArrayBuffer(total), CONFIG.maxUnits, CONFIG.eventCapacity),
    mode: 'copy',
    sendCommand(cmd) {
      worker.postMessage({ kind: 'cmd', cmd });
    },
    sendSelect(quad) {
      worker.postMessage({ kind: 'select', quad });
    },
    sendMove(x, z) {
      worker.postMessage({ kind: 'move', x, z });
    },
  };
  worker.postMessage({ kind: 'init-copy', red, blue, seed });
  worker.onmessage = (e) => {
    if (e.data.kind === 'snapshot' && e.data.buf) {
      const old = channel.views.header.buffer;
      channel.views = makeViews(e.data.buf, CONFIG.maxUnits, CONFIG.eventCapacity);
      worker.postMessage({ kind: 'return', buf: old }, [old]); // 旧缓冲归还乒乓
    }
  };
  return channel;
}

import { defineConfig } from 'vite';

// COOP/COEP 头开启跨源隔离,使 SharedArrayBuffer 可用(模拟快照零拷贝通道)。
// 缺少这两个头时游戏自动降级为复制通道(Transferable 乒乓),功能不受影响。
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
  configurePreviewServer(server) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation],
  build: {
    target: 'esnext',
  },
  worker: {
    format: 'es',
  },
});

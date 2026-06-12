// 入口:hash 路由二选一加载游戏模式,并提供全局致命错误兜底。
//   (默认)   → 对战模式,菜单覆盖在已运行的战场之上
//   #preview → 单位预览模式(从菜单点入时整页刷新切换)

import './style.css';

// 致命错误全屏兜底(原版仅对战模式安装;移到入口让预览模式同样受益)
addEventListener('error', (e) => {
  const el = document.getElementById('fatal');
  if (el && el.style.display !== 'grid') {
    el.style.display = 'grid';
    el.textContent = `发生致命错误:\n${e.message}\n\n请刷新页面重试。`;
  }
});

if (location.hash === '#preview') {
  const { startPreview } = await import('./preview/main.js');
  startPreview();
} else {
  const { startBattle } = await import('./battle/main.js');
  startBattle();
  // 模式菜单:对战在菜单背后即刻开打,点 ⚔ 关菜单;点 🔍 切预览(刷新换模式)
  const menu = document.getElementById('menu');
  if (location.hash !== '#battle') menu.style.display = 'grid';
  document.getElementById('m-battle').addEventListener('click', () => {
    location.hash = '#battle';
    menu.style.display = 'none';
  });
  document.getElementById('m-preview').addEventListener('click', () => {
    location.hash = '#preview';
    location.reload();
  });
}

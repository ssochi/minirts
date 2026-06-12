// RTS 俯视相机:以 focus(注视点)/dist(距离)/yaw/pitch 球坐标描述位姿,
// update() 每帧先消化按键再重算相机位置。键鼠监听(中键拖拽平移、滚轮缩放、
// Q/E 旋转、WASD 平移、J/K 持续缩放)原本就内嵌在 $v 模块的类构造器中,
// 故全部保留在构造器内注册,无需单独的 attach 方法。

import { Vector3, PerspectiveCamera } from 'three';
import { CONFIG } from '../core/config.js';

export class RtsCamera {
  camera;
  focus = new Vector3(CONFIG.mapW / 2, 0, CONFIG.mapH / 2);
  dist = 520;
  yaw = Math.PI / 2;
  pitch = 0.9;
  keys = new Set();
  lastT = performance.now();

  constructor(domElement) {
    this.camera = new PerspectiveCamera(50, innerWidth / innerHeight, 1, 6e3);

    // 中键拖拽平移状态
    let dragging = false,
      lastX = 0,
      lastY = 0;
    domElement.addEventListener('pointerdown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        dragging = true;
        lastX = e.clientX;
        lastY = e.clientY;
      }
    });
    addEventListener('pointerup', () => {
      dragging = false;
    });
    addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // 像素位移按当前镜头距离换算成世界平移量,再按 yaw 旋转到地图坐标系
      const scale = (this.dist / innerHeight) * 1.4;
      const dx = (e.clientX - lastX) * scale;
      const dy = (e.clientY - lastY) * scale;
      const cosY = Math.cos(this.yaw),
        sinY = Math.sin(this.yaw);
      this.focus.x -= sinY * dx + cosY * dy;
      this.focus.z -= -cosY * dx + sinY * dy;
      this.focus.x = Math.min(Math.max(this.focus.x, 0), CONFIG.mapW);
      this.focus.z = Math.min(Math.max(this.focus.z, 0), CONFIG.mapH);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    domElement.addEventListener(
      'wheel',
      (e) => {
        this.dist = Math.min(Math.max(this.dist * (1 + Math.sign(e.deltaY) * 0.12), 40), 1500);
      },
      { passive: true },
    );
    addEventListener('keydown', (e) => {
      if (e.target?.tagName === 'INPUT') return;
      const key = e.key.toLowerCase();
      if (key === 'q') this.yaw -= 0.12;
      if (key === 'e') this.yaw += 0.12;
      if ('wasdjk'.includes(key)) this.keys.add(key);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    addEventListener('blur', () => this.keys.clear());
    this.update();
  }

  // 按住的键每帧持续生效;dt 钳到 50ms 防止切标签页后跳变
  applyKeys() {
    const now = performance.now();
    const dt = Math.min((now - this.lastT) / 1e3, 0.05);
    this.lastT = now;
    if (this.keys.size === 0) return;
    const keys = this.keys;
    const cosY = Math.cos(this.yaw),
      sinY = Math.sin(this.yaw);
    const step = this.dist * 1.1 * dt; // 平移速度随镜头距离缩放
    let dx = 0,
      dz = 0;
    if (keys.has('d')) {
      dx += sinY * step;
      dz += -cosY * step;
    }
    if (keys.has('a')) {
      dx -= sinY * step;
      dz -= -cosY * step;
    }
    if (keys.has('w')) {
      dx += -cosY * step;
      dz += -sinY * step;
    }
    if (keys.has('s')) {
      dx -= -cosY * step;
      dz -= -sinY * step;
    }
    this.focus.x = Math.min(Math.max(this.focus.x + dx, 0), CONFIG.mapW);
    this.focus.z = Math.min(Math.max(this.focus.z + dz, 0), CONFIG.mapH);
    if (keys.has('j')) this.dist *= Math.exp(-1.7 * dt);
    if (keys.has('k')) this.dist *= Math.exp(1.7 * dt);
    this.dist = Math.min(Math.max(this.dist, 40), 1500);
  }

  update() {
    this.applyKeys();
    const cam = this.camera;
    cam.aspect = innerWidth / innerHeight;
    cam.updateProjectionMatrix();
    // 球坐标 → 笛卡尔:相机绕 focus 以 dist 为半径、pitch 为仰角环绕
    const cosP = Math.cos(this.pitch),
      sinP = Math.sin(this.pitch);
    cam.position.set(
      this.focus.x + Math.cos(this.yaw) * this.dist * cosP,
      this.dist * sinP,
      this.focus.z + Math.sin(this.yaw) * this.dist * cosP,
    );
    cam.lookAt(this.focus);
  }
}

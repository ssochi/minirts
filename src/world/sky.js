// 天穹 —— 反向大球面(BackSide)上的程序化渐变天空:
// 地平线亮霾带→天顶冷色,叠加暖色日晕;地平线处精确落到雾色,与地表远端无缝。
// 球心放在地图中心,关闭视锥剔除并最先渲染(renderOrder = -1)。
import { SphereGeometry, ShaderMaterial, Mesh, BackSide } from 'three';
import { CONFIG } from '../core/config.js';

export function buildSky(scene) {
  const geom = new SphereGeometry(4e3, 24, 12);
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {},
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      void main() {
        vec3 fogCol = vec3(0.067, 0.082, 0.106);   // 与 scene.fog 同步
        vec3 zenith = vec3(0.045, 0.062, 0.10);
        vec3 haze   = vec3(0.21, 0.24, 0.295);     // 地平线上方的亮霾带
        float h = max(vDir.y, 0.0);
        vec3 col = mix(haze, zenith, pow(h, 0.5));
        float sun = pow(max(dot(vDir, normalize(vec3(0.5, 0.475, 0.3))), 0.0), 5.0);
        col += vec3(0.50, 0.36, 0.18) * sun * 0.55;            // 暖色日晕
        // 地平线处精确落到雾色,地表远端与天空无缝
        col = mix(fogCol, col, smoothstep(0.0, 0.14, vDir.y));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new Mesh(geom, mat);
  mesh.position.set(CONFIG.mapW / 2, 0, CONFIG.mapH / 2);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  scene.add(mesh);
}

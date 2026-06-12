// 地面与静态布景 —— 三部分:
// buildGround: 按地形高度场起伏的地面网格,程序化画布贴图,onBeforeCompile 注入
//   炮火光斑(uLightGrid)、坡向光/海拔分带/云影等片元逻辑(与单位着色器共用 GLSL);
// buildObstacleMeshes: 岩石/残墙实例网格 + 场景主光(平行光阴影 + 半球光);
// scatterGroundDetail: 碎石与草丛散布(避开阻挡格,种子 CONFIG.seed ^ 1540483477)。
import {
  IcosahedronGeometry,
  Vector3,
  MeshStandardMaterial,
  MeshLambertMaterial,
  Color,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Euler,
  BoxGeometry,
  DirectionalLight,
  HemisphereLight,
  BufferGeometry,
  Float32BufferAttribute,
  CanvasTexture,
  SRGBColorSpace,
  PlaneGeometry,
  Mesh,
  DoubleSide,
} from 'three';
import { CONFIG } from '../core/config.js';
import { makeRng } from '../core/rng.js';
import { terrainHeight, TERRAIN_HEIGHT_GLSL, TERRAIN_GRAD_GLSL } from './terrain.js';
import { CLOUD_SHADE_GLSL } from '../render/shading-glsl.js';
import { GRID_W, GRID_H } from './map-gen.js';

// 标量哈希:经典 sin 噪声,输入相同则输出相同(用于稳定的"随机"外观)
function hash01(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// 岩石几何:单位 icosahedron 细分 1 次,按顶点哈希径向揉皱(0.74~1.14 倍)
function makeRockGeometry() {
  const geom = new IcosahedronGeometry(1, 1);
  const pos = geom.getAttribute(`position`);
  const v = new Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 0.74 + 0.4 * hash01(v.x * 7.31 + v.y * 13.97 + v.z * 23.11);
    pos.setXYZ(i, v.x * k, v.y * k, v.z * k);
  }
  return geom;
}

export function buildObstacleMeshes(scene, shapes) {
  const mat = new MeshStandardMaterial({ roughness: 0.95, metalness: 0.04, flatShading: true });
  const colorA = new Color(0x5c5e63);
  const colorB = new Color(0x71624d);
  const tint = new Color();
  const rocks = new InstancedMesh(makeRockGeometry(), mat, shapes.rocks.length);
  const mtx = new Matrix4();
  const quat = new Quaternion();
  const scl = new Vector3();
  shapes.rocks.forEach((rock, i) => {
    quat.setFromEuler(new Euler(0, rock.x * 7.13, 0));
    scl.set(rock.r, rock.r * 1.15, rock.r);
    mtx.compose(new Vector3(rock.x, rock.r * 0.3 + terrainHeight(rock.x, rock.z), rock.z), quat, scl);
    rocks.setMatrixAt(i, mtx);
    tint
      .copy(colorA)
      .lerp(colorB, hash01(rock.x * 1.7 + rock.z))
      .multiplyScalar(0.82 + 0.36 * hash01(rock.z * 2.3));
    rocks.setColorAt(i, tint);
  });
  const walls = new InstancedMesh(new BoxGeometry(1, 1, 1), mat, shapes.walls.length);
  shapes.walls.forEach((wall, i) => {
    mtx.compose(
      new Vector3(wall.x, 1 + terrainHeight(wall.x, wall.z), wall.z),
      new Quaternion(),
      new Vector3(wall.w, 16, wall.h),
    );
    walls.setMatrixAt(i, mtx);
    tint.copy(colorA).multiplyScalar(0.8 + 0.3 * hash01(wall.x + wall.z * 3.1));
    walls.setColorAt(i, tint);
  });
  rocks.instanceMatrix.needsUpdate = true;
  walls.instanceMatrix.needsUpdate = true;
  rocks.instanceColor.needsUpdate = true;
  walls.instanceColor.needsUpdate = true;
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  walls.castShadow = true;
  walls.receiveShadow = true;
  scene.add(rocks, walls);
  // 场景主光:暖色平行光(带 2048² 阴影)+ 冷色半球环境光
  const sun = new DirectionalLight(0xffeecf, 1.65);
  sun.position.set(CONFIG.mapW / 2 + 400, 380, CONFIG.mapH / 2 + 240);
  sun.target.position.set(CONFIG.mapW / 2, 0, CONFIG.mapH / 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const cam = sun.shadow.camera;
  cam.left = -1e3;
  cam.right = 1e3;
  cam.top = 620;
  cam.bottom = -620;
  cam.near = 1;
  cam.far = 2600;
  cam.updateProjectionMatrix();
  sun.shadow.bias = -0.001;
  scene.add(sun, sun.target, new HemisphereLight(0x9fb0c2, 0x3a3d33, 0.6));
}

export function scatterGroundDetail(scene, map) {
  const rng = makeRng(CONFIG.seed ^ 1540483477);
  const isFree = (x, z) => {
    const gx = Math.min(Math.max((x / CONFIG.gridCell) | 0, 0), GRID_W - 1);
    const gy = Math.min(Math.max((z / CONFIG.gridCell) | 0, 0), GRID_H - 1);
    return map.blocked[gy * GRID_W + gx] === 0;
  };
  const mtx = new Matrix4();
  const quat = new Quaternion();
  const scl = new Vector3();
  const tint = new Color();
  // 碎石:最多 1400 颗,在 6000 次尝试内避开阻挡格落点
  const pebbles = new InstancedMesh(
    new IcosahedronGeometry(1, 0),
    new MeshStandardMaterial({ roughness: 1, metalness: 0, flatShading: true }),
    1400,
  );
  let pebbleCount = 0;
  for (let i = 0; i < 6e3 && pebbleCount < 1400; i++) {
    const x = rng.range(8, CONFIG.mapW - 8);
    const z = rng.range(8, CONFIG.mapH - 8);
    if (!isFree(x, z)) continue;
    const size = 0.25 + rng.range(0, 0.7);
    quat.setFromEuler(new Euler(rng.range(0, 3.14), rng.range(0, 6.28), 0));
    scl.set(size, size * 0.7, size);
    mtx.compose(new Vector3(x, size * 0.2 + terrainHeight(x, z), z), quat, scl);
    pebbles.setMatrixAt(pebbleCount, mtx);
    tint.setRGB(0.26, 0.25, 0.22).multiplyScalar(0.6 + rng.range(0, 0.5));
    pebbles.setColorAt(pebbleCount, tint);
    pebbleCount++;
  }
  pebbles.count = pebbleCount;
  pebbles.instanceMatrix.needsUpdate = true;
  pebbles.instanceColor.needsUpdate = true;
  pebbles.receiveShadow = true;
  scene.add(pebbles);
  // 草丛:5 片三角叶,根部暗、梢部亮(顶点色),环状均布加扰动
  const positions = [];
  const colors = [];
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + i * 1.7;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rootX = cos * 0.1;
    const rootZ = sin * 0.1;
    const tipX = cos * 0.42;
    const tipZ = sin * 0.42;
    const halfW = 0.07;
    const height = 0.5 + 0.3 * hash01(i * 17.3);
    positions.push(
      rootX - sin * halfW, 0, rootZ + cos * halfW,
      rootX + sin * halfW, 0, rootZ - cos * halfW,
      tipX, height, tipZ,
    );
    colors.push(0.14, 0.13, 0.07, 0.14, 0.13, 0.07, 0.38, 0.34, 0.16);
  }
  const tuftGeom = new BufferGeometry();
  tuftGeom.setAttribute(`position`, new Float32BufferAttribute(positions, 3));
  tuftGeom.setAttribute(`color`, new Float32BufferAttribute(colors, 3));
  tuftGeom.computeVertexNormals();
  const tufts = new InstancedMesh(tuftGeom, new MeshLambertMaterial({ vertexColors: true, side: DoubleSide }), 2600);
  let tuftCount = 0;
  for (let i = 0; i < 9e3 && tuftCount < 2600; i++) {
    const x = rng.range(6, CONFIG.mapW - 6);
    const z = rng.range(6, CONFIG.mapH - 6);
    if (!isFree(x, z)) continue;
    const size = rng.range(0.8, 1.9);
    quat.setFromEuler(new Euler(0, rng.range(0, 6.28), 0));
    scl.set(size, size, size);
    mtx.compose(new Vector3(x, terrainHeight(x, z), z), quat, scl);
    tufts.setMatrixAt(tuftCount, mtx);
    tuftCount++;
  }
  tufts.count = tuftCount;
  tufts.instanceMatrix.needsUpdate = true;
  scene.add(tufts);
}

// 程序化地面贴图:2048×1152 画布,独立 LCG 随机(种子 1337,不占用世界 RNG 序列)。
// 内容:底色 + 土斑椭圆 + 车辙划痕 + 弹坑 + 逐像素噪点 + 四边压暗渐变。
function makeGroundTexture() {
  const w = 2048;
  const h = 1152;
  const canvas = document.createElement(`canvas`);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext(`2d`);
  let lcg = 1337;
  const rand = () => (lcg = (lcg * 1103515245 + 12345) & 2147483647) / 2147483647;
  ctx.fillStyle = `#4d5034`;
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 1100; i++) {
    const radius = 8 + rand() * 60;
    ctx.fillStyle =
      rand() < 0.5 ? `rgba(38, 40, 30, ${0.05 + rand() * 0.11})` : `rgba(82, 78, 54, ${0.04 + rand() * 0.1})`;
    ctx.beginPath();
    ctx.ellipse(rand() * w, rand() * h, radius, radius * (0.35 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 70; i++) {
    const y = rand() * h;
    const len = 250 + rand() * 900;
    const x = rand() * (w - len);
    ctx.strokeStyle =
      rand() < 0.5 ? `rgba(28, 28, 20, ${0.06 + rand() * 0.1})` : `rgba(90, 84, 60, ${0.05 + rand() * 0.08})`;
    ctx.lineWidth = 1.2 + rand() * 2.2;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rand() - 0.5) * 26);
    ctx.stroke();
  }
  for (let i = 0; i < 46; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const radius = 3.5 + rand() * 9;
    ctx.fillStyle = `rgba(20, 19, 14, ${0.22 + rand() * 0.2})`;
    ctx.beginPath();
    ctx.ellipse(x, y, radius, radius * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(98, 90, 64, 0.22)`;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(x, y, radius + 1.6, radius * 0.8 + 1.6, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rand() - 0.5) * 16;
    data[i] += noise;
    data[i + 1] += noise;
    data[i + 2] += noise;
  }
  ctx.putImageData(image, 0, 0);
  for (const [x0, y0, x1, y1] of [
    [0, 0, 0, 38],
    [0, h, 0, h - 38],
    [0, 0, 38, 0],
    [w, 0, w - 38, 0],
  ]) {
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, `rgba(0,0,0,0.45)`);
    grad.addColorStop(1, `rgba(0,0,0,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export function buildGround(scene, flashTex, cloudUniform) {
  // 200×112 段平面,顶点按解析高度场抬升(与 CPU terrainHeight 同源)
  const geom = new PlaneGeometry(CONFIG.mapW, CONFIG.mapH, 200, 112)
    .rotateX(-Math.PI / 2)
    .translate(CONFIG.mapW / 2, 0, CONFIG.mapH / 2);
  const pos = geom.getAttribute(`position`);
  for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(pos.getX(i), pos.getZ(i)));
  geom.computeVertexNormals();
  const mat = new MeshLambertMaterial({ map: makeGroundTexture() });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uLightGrid = { value: flashTex };
    shader.uniforms.uCloudT = cloudUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        `void main() {`,
        `uniform sampler2D uLightGrid;
uniform float uCloudT;
` +
          TERRAIN_HEIGHT_GLSL +
          TERRAIN_GRAD_GLSL +
          CLOUD_SHADE_GLSL +
          `void main() {`,
      )
      .replace(
        `#include <emissivemap_fragment>`,
        `
      #include <emissivemap_fragment>
      totalEmissiveRadiance += texture2D(uLightGrid, vec2(vMapUv.x, 1.0 - vMapUv.y)).rgb
        * (diffuseColor.rgb * 0.8 + 0.18);
      `,
      )
      .replace(
        `#include <map_fragment>`,
        `
      #include <map_fragment>
      {
        vec2 wuv = vMapUv * vec2(${CONFIG.mapW}.0, ${CONFIG.mapH}.0);
        float d1 = fract(sin(dot(floor(wuv * 2.0), vec2(127.1, 311.7))) * 43758.5453);
        float d2 = fract(sin(dot(floor(wuv * 9.0), vec2(269.5, 183.3))) * 28461.8853);
        diffuseColor.rgb *= 0.86 + 0.26 * (d1 * 0.55 + d2 * 0.45);
        // 坡向光:平地=1,向阳坡>1,背阳坡<1(与场景太阳方向一致),pow 拉开对比
        vec2 tg = terrainGrad(wuv);
        vec3 tn = normalize(vec3(-tg.x, 1.0, -tg.y));
        vec3 sl = normalize(vec3(0.5, 0.475, 0.3));
        diffuseColor.rgb *= pow(clamp(dot(tn, sl) / sl.y, 0.55, 1.5), 1.4);
        // 海拔分带:谷底湿暗,坡顶干亮并偏枯黄
        float hn = smoothstep(-9.5, 9.5, terrainH(wuv));
        diffuseColor.rgb *= mix(0.78, 1.14, hn);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.10, 1.05, 0.84), hn * 0.6);
        diffuseColor.rgb *= cloudShade(wuv, uCloudT); // 云影漂过(与单位着色器同函数)
      }
    `,
      );
  };
  const mesh = new Mesh(geom, mat);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  scene.add(mesh);
}

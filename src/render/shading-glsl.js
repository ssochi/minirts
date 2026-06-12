// 共享光照 GLSL 片段 —— 单位阴影采样 / ACES 色调映射 / 天穹环境光 / 云影。
// 被车队渲染器、地面、残骸、碎片等多个着色器拼接复用。
// 字符串内中文注释为原作者所写,逐字保留。

export const UNIT_SHADOW_GLSL = `
  float unpackShadowDepth(vec4 v) {
    return dot(v, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
  }
  // 频外/未就绪恒为 1(全亮);4 tap PCF;返回 0.25(全影)..1(全亮)
  float sampleUnitShadow(sampler2D map, mat4 m, vec3 w, float on) {
    if (on < 0.5) return 1.0;
    vec4 sc = m * vec4(w, 1.0);
    vec3 p = sc.xyz / sc.w;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
    float z = p.z - 0.0022;
    float ts = 1.6 / 2048.0;
    float s = step(z, unpackShadowDepth(texture2D(map, p.xy + vec2(-ts, -ts))))
            + step(z, unpackShadowDepth(texture2D(map, p.xy + vec2(ts, -ts))))
            + step(z, unpackShadowDepth(texture2D(map, p.xy + vec2(-ts, ts))))
            + step(z, unpackShadowDepth(texture2D(map, p.xy + vec2(ts, ts))));
    return 0.3 + 0.7 * s * 0.25; // 阴影保留 30% 直射感,不打死黑
  }
`;

export const SHADING_GLSL =
  `
  // ACES(Narkowicz 拟合);预增益对齐内置 ACESFilmic 的观感
  vec3 acesTonemap(vec3 x) {
    x *= 1.0;
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  // 天穹环境(金属反射采样用),与 buildSky 同一渐变 + 日晕
  vec3 skyEnv(vec3 d) {
    vec3 col = mix(vec3(0.21, 0.24, 0.295), vec3(0.045, 0.062, 0.10), pow(max(d.y, 0.0), 0.5));
    float sun = pow(max(dot(d, normalize(vec3(0.5, 0.475, 0.3))), 0.0), 5.0);
    return col + vec3(0.50, 0.36, 0.18) * sun * 0.55;
  }
  // 三方向环境光:天顶冷光 / 地平线霾 / 地面暖反照
  //(手绘游戏经验:环境光给足、光比放小,背光面也能读出纹理细节,不死黑)
  vec3 ambient3(vec3 n) {
    vec3 a = mix(vec3(0.30, 0.32, 0.37), vec3(0.42, 0.52, 0.64), max(n.y, 0.0));
    return mix(a, vec3(0.27, 0.24, 0.18), max(-n.y, 0.0));
  }
` + UNIT_SHADOW_GLSL;

export const CLOUD_SHADE_GLSL = `
  float cloudShade(vec2 p, float t) {
    vec2 q = p * 0.009 + vec2(t * 0.055, t * 0.021);
    float a = sin(q.x * 1.0 + 1.7) * sin(q.y * 1.3 + 0.4)
            + 0.6 * sin(q.x * 2.3 + t * 0.05 + 4.0) * sin(q.y * 2.9 + 2.0);
    return 1.0 - smoothstep(0.15, 1.4, a) * 0.20;
  }
`;

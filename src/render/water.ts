import * as THREE from 'three';
import { BILINEAR, CHILD_CUT, NOISE, SKY } from './glsl';

const VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uStatic;
uniform sampler2D uEta;       // R = 그릴 수위, G = 젖음, B = 수심, A = 거품
uniform ivec2 uSize;
uniform vec2 uExtent;
uniform float uExag;
uniform float uWaveBoost;     // 먼 거리에서 파고를 더 과장하는 배율. 깊은 바다에만 적용한다.
out vec2 vTexel;
out vec3 vWorld;
out float vBoost;
${BILINEAR}
void main() {
  vTexel = uv * vec2(uSize);
  float z = bilinear(uStatic, vTexel, uSize).r;
  float eta = bilinear(uEta, vTexel, uSize).r;
  // 해안 근처에서는 과장을 풀어 물과 지형의 높이 관계가 어긋나지 않게 한다
  vBoost = 1.0 + (uWaveBoost - 1.0) * smoothstep(20.0, 200.0, -z);
  float vis = eta * vBoost;
  // 과장된 골이 해저면 아래로 내려가면 해저가 수면을 뚫고 보인다. 수심의 40%까지만 내려가게 한다.
  if (z < 0.0 && vBoost > 1.0) vis = max(vis, z * 0.4);
  vec3 pos = vec3((uv.x - 0.5) * uExtent.x, vis * uExag * 0.001, (uv.y - 0.5) * uExtent.y);
  vec4 w = modelMatrix * vec4(pos, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uStatic;
uniform sampler2D uEta;
uniform sampler2D uRecord;
uniform float uTimeNow;
uniform int uOverlay;
uniform ivec2 uSize;
uniform float uCellM;
uniform float uExag;
uniform float uClock;         // 잔물결 애니메이션용 벽시계 시간(s)
uniform float uTintScale;     // 파고 색을 입힐 기준 진폭(m). 0이면 끔
uniform float uFogDensity;
uniform float uRippleScale;   // 잔물결 한 주기의 길이(셀)
uniform vec3 uCamPos;
in vec2 vTexel;
in vec3 vWorld;
layout(location = 0) out highp vec4 outColor;
in float vBoost;
${BILINEAR}
${SKY}
${CHILD_CUT}
${NOISE}

void main() {
  if (insideChild(vTexel)) discard;
  vec4 e = bilinear(uEta, vTexel, uSize);
  if (e.g < 0.3) discard;
  vec4 st = bilinear(uStatic, vTexel, uSize);
  float depth = e.r - st.r;
  if (depth <= 0.0) discard;

  // 수면 법선: 계산된 수위의 기울기 + 보기 좋게 얹는 잔물결
  float ex = bilinear(uEta, vTexel + vec2(1.0, 0.0), uSize).r - bilinear(uEta, vTexel - vec2(1.0, 0.0), uSize).r;
  float ey = bilinear(uEta, vTexel + vec2(0.0, 1.0), uSize).r - bilinear(uEta, vTexel - vec2(0.0, 1.0), uSize).r;
  float wetAll = smoothstep(0.6, 1.0, e.g);
  float k = vBoost * uExag / (2.0 * uCellM) * wetAll;
  vec2 rp = vTexel / uRippleScale;
  float t = uClock * 0.35;
  float r1 = fbm(rp + vec2(t, t * 0.6)), r2 = fbm(rp * 1.7 - vec2(t * 0.8, -t * 0.5));
  float rdx = fbm(rp + vec2(0.35, 0.0) + vec2(t, t * 0.6)) - r1 + fbm(rp * 1.7 + vec2(0.35, 0.0) - vec2(t * 0.8, -t * 0.5)) - r2;
  float rdy = fbm(rp + vec2(0.0, 0.35) + vec2(t, t * 0.6)) - r1 + fbm(rp * 1.7 + vec2(0.0, 0.35) - vec2(t * 0.8, -t * 0.5)) - r2;
  float rippleAmp = 0.22 * smoothstep(0.0, 1.5, depth);
  // 먼 거리에서는 파고를 수천 배 과장하므로 기울기도 그만큼 커진다. 그대로 쓰면 수면이 수평선을 반사해
  // 회색 띠가 생긴다. 음영에 쓰는 기울기는 상한을 둔다.
  vec2 g = vec2(ex, ey) * k;
  float gl = length(g);
  if (gl > 0.45) g *= 0.45 / gl;
  vec3 n = normalize(vec3(-g.x - rdx * rippleAmp, 1.0, -g.y - rdy * rippleAmp));

  vec3 view = normalize(uCamPos - vWorld);
  float fres = 0.03 + 0.97 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
  vec3 refl = skyColor(reflect(-view, n));

  // 물빛: 얕으면 바닥이 비치고 깊어질수록 짙어진다
  bool onLand = st.a < 0.5;
  vec3 shallow = vec3(0.20, 0.62, 0.66);
  vec3 deep = vec3(0.02, 0.13, 0.27);
  vec3 body = mix(shallow, deep, 1.0 - exp(-depth / 60.0));
  float alpha = 1.0 - exp(-depth / 2.2);
  if (onLand) {
    // 육지를 덮은 물은 흙탕물
    vec3 mud = vec3(0.36, 0.31, 0.22);
    body = mix(mud, vec3(0.20, 0.24, 0.22), 1.0 - exp(-depth / 6.0));
    alpha = 1.0 - exp(-depth / 0.45);
  }
  float diff = 0.55 + 0.45 * max(dot(n, uSunDir), 0.0);
  vec3 color = mix(body * diff, refl, fres * (onLand ? 0.55 : 1.0));

  // 파고 색: 마루는 밝은 주황, 골은 짙은 청록. 먼 거리에서 파면을 읽기 쉽게 한다
  if (uTintScale > 0.0 && !onLand) {
    float a = e.r / uTintScale;
    float m = clamp(log(1.0 + abs(a) * 8.0) / log(9.0), 0.0, 1.0);
    vec3 tint = a > 0.0 ? vec3(1.0, 0.55, 0.25) : vec3(0.10, 0.75, 0.85);
    color = mix(color, tint, m * 0.75);
  }

  // 거품: 단파가 만든 거품(추적자) + 육지를 덮어 가는 파면. 파면은 물이 닿은 지 얼마 안 된 셀로 찾는다.
  float foamNoise = fbm(vTexel * 0.9 + vec2(t * 2.0, -t));
  float foam = e.a;
  if (onLand) {
    float arrived = texelFetch(uRecord, clamp(ivec2(vTexel), ivec2(0), uSize - 1), 0).g;
    if (arrived >= 0.0) foam = max(foam, 1.0 - smoothstep(0.0, 75.0, uTimeNow - arrived));
  }
  foam = clamp(foam * smoothstep(0.25, 0.75, foamNoise + foam * 0.5), 0.0, 1.0);
  color = mix(color, vec3(0.93, 0.94, 0.92) * diff, foam * 0.85);
  alpha = max(alpha, foam * 0.85);
  alpha *= smoothstep(0.0, 0.06, depth);
  alpha = max(alpha, fres * 0.6 * smoothstep(0.0, 0.3, depth));

  // 침수심이나 도달 시간을 볼 때는 육지 위의 물을 거의 투명하게 해서 지형에 칠한 색이 보이게 한다
  if (uOverlay > 0 && onLand) alpha *= 0.12;

  color = applyFog(color, length(vWorld - uCamPos), uFogDensity);
  outColor = vec4(color, clamp(alpha, 0.0, 1.0));
}
`;

export interface WaterUniformInput {
  staticTex: THREE.Texture;
  nx: number;
  ny: number;
  extentKm: [number, number];
  cellM: number;
  rippleScale: number;
}

export function makeWaterMaterial(inp: WaterUniformInput, shared: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uStatic: { value: inp.staticTex },
      uEta: { value: null },
      uRecord: { value: null },
      uTimeNow: shared.uTimeNow,
      uOverlay: shared.uOverlay,
      uSize: { value: new THREE.Vector2(inp.nx, inp.ny) },
      uExtent: { value: new THREE.Vector2(inp.extentKm[0], inp.extentKm[1]) },
      uCellM: { value: inp.cellM },
      uRippleScale: { value: inp.rippleScale },
      uChildRect: { value: new THREE.Vector4() },
      uHasChild: { value: 0 },
      uExag: shared.uExag,
      uWaveBoost: shared.uWaveBoost,
      uClock: shared.uClock,
      uTintScale: shared.uTintScale,
      uFogDensity: shared.uFogDensity,
      uCamPos: shared.uCamPos,
      uSunDir: shared.uSunDir,
    },
  });
}

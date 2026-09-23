import * as THREE from 'three';
import { BILINEAR, CHILD_CUT, SKY } from './glsl';

export type OverlayMode = 'none' | 'maxDepth' | 'arrival' | 'speed';
export const OVERLAY_INDEX: Record<OverlayMode, number> = { none: 0, maxDepth: 1, arrival: 2, speed: 3 };

const VERT = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uStatic;
uniform ivec2 uSize;
uniform vec2 uExtent;     // 이 단계가 장면에서 차지하는 크기(km)
uniform float uExag;      // 수직 과장
out vec2 vTexel;
out vec3 vWorld;
${BILINEAR}
void main() {
  vTexel = uv * vec2(uSize);
  float z = bilinear(uStatic, vTexel, uSize).r;
  vec3 pos = vec3((uv.x - 0.5) * uExtent.x, z * uExag * 0.001, (uv.y - 0.5) * uExtent.y);
  vec4 w = modelMatrix * vec4(pos, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uStatic;
uniform sampler2D uRecord;
uniform sampler2D uDrape;
uniform float uDrapeMix;
uniform ivec2 uSize;
uniform float uCellM;        // 셀 크기(m), 음영 계산용
uniform float uShadeExag;
uniform float uExag;
uniform int uOverlay;
uniform float uTimeNow;
uniform float uArrivalSpan;  // 도달 시간 색상표의 범위(s)
uniform float uFogDensity;
uniform vec3 uCamPos;
in vec2 vTexel;
in vec3 vWorld;
layout(location = 0) out highp vec4 outColor;
${BILINEAR}
${SKY}
${CHILD_CUT}

vec3 ramp(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  t = clamp(t, 0.0, 1.0) * 3.0;
  if (t < 1.0) return mix(a, b, t);
  if (t < 2.0) return mix(b, c, t - 1.0);
  return mix(c, d, t - 2.0);
}
vec3 landColor(float z) {
  // 저지대 녹색에서 고지대 회백색으로
  vec3 c = ramp(z / 600.0, vec3(0.52, 0.60, 0.42), vec3(0.66, 0.66, 0.47), vec3(0.62, 0.53, 0.40), vec3(0.55, 0.50, 0.46));
  c = mix(c, vec3(0.80, 0.78, 0.76), smoothstep(900.0, 2200.0, z));
  c = mix(c, vec3(0.96, 0.96, 0.97), smoothstep(2200.0, 3500.0, z));
  // 바닷가만 모래빛으로
  return mix(vec3(0.70, 0.70, 0.54), c, smoothstep(0.0, 3.0, z));
}
vec3 seabedColor(float z) {
  vec3 shallow = vec3(0.72, 0.70, 0.58);
  vec3 shelf = vec3(0.30, 0.42, 0.47);
  vec3 deep = vec3(0.07, 0.14, 0.24);
  float d = -z;
  vec3 c = mix(shallow, shelf, smoothstep(0.0, 120.0, d));
  return mix(c, deep, smoothstep(120.0, 5000.0, d));
}
// 침수심 등급: 0.5, 2, 5, 10 m
vec3 depthClass(float d) {
  if (d < 0.5) return vec3(0.98, 0.90, 0.45);
  if (d < 2.0) return vec3(0.98, 0.62, 0.20);
  if (d < 5.0) return vec3(0.90, 0.24, 0.16);
  if (d < 10.0) return vec3(0.68, 0.18, 0.78);
  return vec3(0.33, 0.06, 0.48);
}
vec3 arrivalColor(float t) {
  return ramp(t, vec3(1.0, 0.93, 0.55), vec3(0.93, 0.50, 0.22), vec3(0.55, 0.20, 0.45), vec3(0.14, 0.11, 0.30));
}

void main() {
  if (insideChild(vTexel)) discard;
  vec4 st = bilinear(uStatic, vTexel, uSize);
  float z = st.r;
  // 법선은 화면 픽셀 하나가 덮는 텍셀 수만큼 넓은 간격으로 구한다. 멀리서 볼 때 세밀 격자의 급한 경사가
  // 잡음처럼 보이는 것을 막고, 단계가 달라도 음영 세기가 같아 보이게 한다.
  float span = clamp(max(fwidth(vTexel.x), fwidth(vTexel.y)), 1.0, 24.0);
  float zx = bilinear(uStatic, vTexel + vec2(span, 0.0), uSize).r - bilinear(uStatic, vTexel - vec2(span, 0.0), uSize).r;
  float zy = bilinear(uStatic, vTexel + vec2(0.0, span), uSize).r - bilinear(uStatic, vTexel - vec2(0.0, span), uSize).r;
  float k = uExag * uShadeExag / (2.0 * span * uCellM);
  vec3 n = normalize(vec3(-zx * k, 1.0, -zy * k));
  float diff = max(dot(n, uSunDir), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  float shade = 0.38 * sky + 0.78 * diff;

  bool sea = st.a > 0.5;
  vec3 base = sea ? seabedColor(z) : landColor(z);
  if (uDrapeMix > 0.0 && !sea) {
    vec3 d = texture(uDrape, vec2(vTexel.x / float(uSize.x), 1.0 - vTexel.y / float(uSize.y))).rgb;
    base = mix(base, d, uDrapeMix);
    shade = mix(shade, 0.55 + 0.55 * diff, uDrapeMix * 0.6);
  }
  vec4 rec = texelFetch(uRecord, clamp(ivec2(vTexel), ivec2(0), uSize - 1), 0);
  // 물이 한 번 덮었던 땅은 젖은 흙빛으로 어둡게 한다. 물이 빠진 뒤에도 침수 범위가 남아 보인다.
  if (!sea && rec.r > -1e4 && rec.r - z > 0.05) base = mix(base, vec3(0.30, 0.27, 0.22), 0.55);
  vec3 color = base * shade;

  if (uOverlay > 0) {
    if (uOverlay == 1 && !sea) {
      float d = rec.r - z;
      if (rec.r > -1e4 && d > 0.03) color = mix(color, depthClass(d) * (0.6 + 0.4 * shade), 0.82);
    } else if (uOverlay == 2 && rec.g >= 0.0 && !sea) {
      color = mix(color, arrivalColor(rec.g / uArrivalSpan) * (0.6 + 0.4 * shade), 0.8);
    } else if (uOverlay == 3 && !sea && rec.b > 0.05) {
      color = mix(color, ramp(rec.b / 10.0, vec3(0.75, 0.90, 0.98), vec3(0.30, 0.65, 0.95), vec3(0.95, 0.75, 0.20), vec3(0.85, 0.15, 0.15)) * (0.6 + 0.4 * shade), 0.8);
    }
  }
  color = applyFog(color, length(vWorld - uCamPos), uFogDensity);
  outColor = vec4(color, 1.0);
}
`;

export interface TerrainUniformInput {
  staticTex: THREE.Texture;
  nx: number;
  ny: number;
  extentKm: [number, number];
  cellM: number;
  shadeExag: number;
}

export function makeGridGeometry(segX: number, segY: number): THREE.BufferGeometry {
  const vx = segX + 1, vy = segY + 1;
  const pos = new Float32Array(vx * vy * 3);
  const uv = new Float32Array(vx * vy * 2);
  for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
    const k = j * vx + i;
    uv[k * 2] = i / segX;
    uv[k * 2 + 1] = j / segY;
  }
  const idx = new Uint32Array(segX * segY * 6);
  let o = 0;
  for (let j = 0; j < segY; j++) for (let i = 0; i < segX; i++) {
    const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
    idx[o++] = a; idx[o++] = c; idx[o++] = b;
    idx[o++] = b; idx[o++] = c; idx[o++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function makeTerrainMaterial(inp: TerrainUniformInput, shared: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uStatic: { value: inp.staticTex },
      uRecord: { value: null },
      uDrape: { value: null },
      uDrapeMix: { value: 0 },
      uSize: { value: new THREE.Vector2(inp.nx, inp.ny) },
      uExtent: { value: new THREE.Vector2(inp.extentKm[0], inp.extentKm[1]) },
      uCellM: { value: inp.cellM },
      uShadeExag: { value: inp.shadeExag },
      uChildRect: { value: new THREE.Vector4() },
      uHasChild: { value: 0 },
      uExag: shared.uExag,
      uOverlay: shared.uOverlay,
      uTimeNow: shared.uTimeNow,
      uArrivalSpan: shared.uArrivalSpan,
      uFogDensity: shared.uFogDensity,
      uCamPos: shared.uCamPos,
      uSunDir: shared.uSunDir,
    },
  });
}

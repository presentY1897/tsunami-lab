import { LocalizedError } from '../i18n';
import type { AdaptiveMesh } from './adaptive';
import { STRIDE } from './adaptive';
import type { GlobeCamera } from './camera';
import type { Vec3 } from './mat4';

const WAVE_GLSL = /* glsl */ `
// 파도. 계산 격자의 상태 텍스처를 그대로 읽는다. 메시를 어떻게 나눴는지와는 무관하다(결정 D-020).
// 단계 0은 전 지구 격자(경도 순환), 1~3은 그 안의 세밀한 격자다. 세밀한 단계부터 찾아 그 안이면 그 값을 읽는다.
uniform highp sampler2D uL0State;
uniform highp sampler2D uL0Bed;
uniform ivec2 uL0Size;
uniform vec2 uL0Origin;
uniform float uL0World;
uniform float uL0On;
uniform highp sampler2D uL1State;
uniform highp sampler2D uL1Bed;
uniform ivec2 uL1Size;
uniform vec2 uL1Origin;
uniform float uL1World;
uniform float uL1On;
uniform highp sampler2D uL2State;
uniform highp sampler2D uL2Bed;
uniform ivec2 uL2Size;
uniform vec2 uL2Origin;
uniform float uL2World;
uniform float uL2On;
uniform highp sampler2D uL3State;
uniform highp sampler2D uL3Bed;
uniform ivec2 uL3Size;
uniform vec2 uL3Origin;
uniform float uL3World;
uniform float uL3On;
// 최대 침수 범위. 해안 격자의 기록(R = 최대 수위)과 지반. 물이 빠진 뒤에도 잠겼던 땅에 침수심 등급의 색이 남는다.
uniform highp sampler2D uFloodRec;
uniform highp sampler2D uFloodBed;
uniform ivec2 uFloodSize;
uniform vec2 uFloodOrigin;
uniform float uFloodWorld;
uniform float uFloodBox;   // 해안 격자가 있는가
uniform float uFloodOn;    // 침수 색칠을 켰는가
uniform float uSimT;       // 계산 시각(s). 계산이 없으면 -1
uniform float uWaveOn;
uniform float uWaveVis;    // 깊은 바다에서 기준 진폭의 파도가 솟아 보이는 높이. 반지름 단위
uniform float uWaveRef;    // 색을 입히는 기준 진폭(m)
// 소행성 원거리 감쇠 보정. 보정이 안 된 단계(전 지구, 발생원)의 값에 √(기준/r)를 곱한다. uLkGain은 단계별 기준 거리(m), 0이면 없음.
uniform vec3 uGainSrc;
uniform float uL0Gain;
uniform float uL1Gain;
uniform float uL2Gain;
uniform float uL3Gain;
const float PI = 3.141592653589793;
float gainFor(vec3 d, float ref) {
  if (ref <= 0.0) return 1.0;
  float r = acos(clamp(dot(d, uGainSrc), -1.0, 1.0)) * 6371000.0;
  return min(1.0, sqrt(ref / max(r, 1.0)));
}

// 젖은 셀만 가중해 쌍선형 보간한다. 마른 셀의 상태값은 지반 표고라서 섞으면 안 된다. x = 수위, y = 격자 지반. 젖은 이웃이 없으면 x = -1e5.
vec2 sampleGrid(highp sampler2D st, highp sampler2D bd, ivec2 size, vec2 uv, bool wrapX) {
  ivec2 q = ivec2(floor(uv));
  vec2 t = uv - vec2(q);
  float sum = 0.0, bsum = 0.0, wsum = 0.0;
  for (int dj = 0; dj <= 1; dj++) for (int di = 0; di <= 1; di++) {
    int x = q.x + di;
    x = wrapX ? ((x % size.x) + size.x) % size.x : clamp(x, 0, size.x - 1);
    ivec2 c = ivec2(x, clamp(q.y + dj, 0, size.y - 1));
    float e = texelFetch(st, c, 0).r, b = texelFetch(bd, c, 0).r;
    float w = (di == 0 ? 1.0 - t.x : t.x) * (dj == 0 ? 1.0 - t.y : t.y);
    if (e - b > 0.05) { sum += w * e; bsum += w * b; wsum += w; }
  }
  return wsum > 1e-4 ? vec2(sum / wsum, bsum / wsum) : vec2(-1e5, 0.0);
}

// 이 점의 수위(m)와 그 값이 나온 격자 칸의 지반(m). 젖은 셀이 없으면 수위 -1e5.
vec2 waveAtRaw2(vec3 d) {
  float lat = asin(clamp(d.y, -0.9962, 0.9962));
  float mx = atan(d.x, d.z) / (2.0 * PI) + 0.5;          // 0..1
  float my = (1.0 - asinh(tan(lat)) / PI) * 0.5;          // 0..1
  if (uL3On > 0.5) {
    float u = mx * uL3World - uL3Origin.x - 0.5;
    if (u < -0.5) u += uL3World;
    float v = my * uL3World - uL3Origin.y - 0.5;
    if (u >= 10.0 && u <= float(uL3Size.x) - 11.0 && v >= 10.0 && v <= float(uL3Size.y) - 11.0) { vec2 s = sampleGrid(uL3State, uL3Bed, uL3Size, vec2(u, v), false); return s.x < -1e4 ? s : vec2(s.x * gainFor(d, uL3Gain), s.y); }
  }
  if (uL2On > 0.5) {
    float u = mx * uL2World - uL2Origin.x - 0.5;
    if (u < -0.5) u += uL2World;
    float v = my * uL2World - uL2Origin.y - 0.5;
    if (u >= 10.0 && u <= float(uL2Size.x) - 11.0 && v >= 10.0 && v <= float(uL2Size.y) - 11.0) { vec2 s = sampleGrid(uL2State, uL2Bed, uL2Size, vec2(u, v), false); return s.x < -1e4 ? s : vec2(s.x * gainFor(d, uL2Gain), s.y); }
  }
  if (uL1On > 0.5) {
    float u = mx * uL1World - uL1Origin.x - 0.5;
    if (u < -0.5) u += uL1World;
    float v = my * uL1World - uL1Origin.y - 0.5;
    if (u >= 10.0 && u <= float(uL1Size.x) - 11.0 && v >= 10.0 && v <= float(uL1Size.y) - 11.0) { vec2 s = sampleGrid(uL1State, uL1Bed, uL1Size, vec2(u, v), false); return s.x < -1e4 ? s : vec2(s.x * gainFor(d, uL1Gain), s.y); }
  }
  float u = mx * float(uL0Size.x) - 0.5;
  float v = my * uL0World - uL0Origin.y - 0.5;
  if (v < 0.0 || v > float(uL0Size.y - 1)) return vec2(0.0, -4000.0);
  vec2 s = sampleGrid(uL0State, uL0Bed, uL0Size, vec2(u, v), true);
  return s.x < -1e4 ? s : vec2(s.x * gainFor(d, uL0Gain), s.y);
}
float waveAtRaw(vec3 d) { return waveAtRaw2(d).x; }
float waveAt(vec3 d) { return max(waveAtRaw(d), -1e4); }
// 격자 칸 수심에서 이 자리 수심까지 파가 커지는 배율(1~5배). Green 법칙 (칸 수심 / 자리 수심)^(1/4)이되, 파고가 수심에 이르면 멈추고(부서짐)
// 그 뒤로는 1.5배만 더 오른다(D-038). 판정의 처오름과 같은 식이라 바다 수면이 해안선에서 판정 수위와 이어진다(D-036).
float shoalGain(float cellDepth, float localDepth, float amp) {
  float h0 = max(cellDepth, 1.0);
  float green = pow(h0 / max(localDepth, 1.0), 0.25);
  float brk = 1.5 * max(1.0, pow(h0 / max(amp, 1e-3), 0.2));
  return clamp(min(green, brk), 1.0, 5.0);
}

// 이 점이 해안 격자(직접 계산) 안인가
bool inCoastGrid(vec3 d) {
  if (uFloodBox < 0.5) return false;
  float lat = asin(clamp(d.y, -0.9962, 0.9962));
  float u = (atan(d.x, d.z) / (2.0 * PI) + 0.5) * uFloodWorld - uFloodOrigin.x - 0.5;
  if (u < -0.5) u += uFloodWorld;
  float v = (1.0 - asinh(tan(lat)) / PI) * 0.5 * uFloodWorld - uFloodOrigin.y - 0.5;
  return u >= 0.0 && v >= 0.0 && u <= float(uFloodSize.x) - 1.0 && v <= float(uFloodSize.y) - 1.0;
}
// 이 점의 최대 침수심(m). 해안 격자 안에서 잠긴 적이 없으면 0, 해안 격자 밖이면 -1. 잠긴 셀만 가중해 쌍선형 보간한다.
float floodDepthAt(vec3 d) {
  if (uFloodBox < 0.5) return -1.0;
  float lat = asin(clamp(d.y, -0.9962, 0.9962));
  float u = (atan(d.x, d.z) / (2.0 * PI) + 0.5) * uFloodWorld - uFloodOrigin.x - 0.5;
  if (u < -0.5) u += uFloodWorld;
  float v = (1.0 - asinh(tan(lat)) / PI) * 0.5 * uFloodWorld - uFloodOrigin.y - 0.5;
  if (u < 0.0 || v < 0.0 || u > float(uFloodSize.x) - 1.0 || v > float(uFloodSize.y) - 1.0) return -1.0;
  ivec2 q = ivec2(floor(u), floor(v));
  vec2 t = vec2(u, v) - vec2(q);
  float sum = 0.0, wsum = 0.0;
  for (int dj = 0; dj <= 1; dj++) for (int di = 0; di <= 1; di++) {
    ivec2 c = clamp(q + ivec2(di, dj), ivec2(0), uFloodSize - 1);
    float w = (di == 0 ? 1.0 - t.x : t.x) * (dj == 0 ? 1.0 - t.y : t.y);
    float r = texelFetch(uFloodRec, c, 0).r;
    if (r < -1e4) { wsum += w; continue; }
    float depth = r - texelFetch(uFloodBed, c, 0).r;
    if (depth > 0.05) sum += w * depth;
    wsum += w;
  }
  return wsum > 1e-4 ? sum / wsum : 0.0;
}
// 침수심 등급의 색. 0.5, 2, 5, 10, 20, 50 m. 20 m 위는 소행성에서만 나온다(D-035)
vec3 floodColor(float d) {
  if (d < 0.5) return vec3(0.98, 0.90, 0.45);
  if (d < 2.0) return vec3(0.98, 0.62, 0.20);
  if (d < 5.0) return vec3(0.90, 0.24, 0.16);
  if (d < 10.0) return vec3(0.68, 0.18, 0.78);
  if (d < 20.0) return vec3(0.33, 0.06, 0.48);
  if (d < 50.0) return vec3(0.14, 0.04, 0.34);
  return vec3(0.03, 0.02, 0.14);
}
`;

const VERT = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
in vec3 aRel;      // 보는 지점을 원점으로 한 단위 구 위의 상대 좌표
in vec2 aH;        // x = 실제 높이(m), y = 음영용 높이(m)
in vec2 aFlood;    // 경험식 판정: x = 최대 물 높이(m, 없으면 지반 아래), y = 침수 전선 도달 시각(s)
in vec3 aCoast;    // 값을 준 해안 칸의 중심(rad 경도, rad 위도)과 그 칸 수위에 곱할 비율 1 − d/X. 없으면 비율 0
in vec4 aColor;    // 알파가 1이면 물 층
uniform mat4 uViewProj;    // 상대 좌표용
uniform vec3 uOrigin;
uniform float uSeaLevel;
uniform float uExag;       // 미터당 반지름 단위 (수직 과장 포함)
flat out vec4 vColor;
out vec3 vRelief;
out vec3 vPos;
out vec3 vDir;
out vec2 vFlood;
out float vH;
out vec3 vBarycentric;
out float vShoal;  // 이 자리의 얕아짐 배율. 색에도 같이 쓴다
${WAVE_GLSL}
void main() {
  vec3 d = normalize(aRel + uOrigin);
  bool water = aColor.a > 0.5;
  // 육지 위의 물 면(알파 0.78): 계산된 수위가 지반보다 높은 곳에만 보이고, 아니면 지형 아래로 숨긴다
  bool flood = water && aColor.a < 0.9;
  // 물 층의 음영용 기복은 약하게 준다. 대륙붕 경사가 해안을 따라 짙은 띠로 끼는 것을 막는다.
  float relief = aH.y * uExag * (water ? 0.3 : 1.0);
  float height = aH.x * uExag;
  vColor = aColor;
  vShoal = 1.0;
  if (flood) {
    // 해안 격자 안은 직접 계산한 수위. 밖은 값을 준 해안 칸의 현재 수위를 해안선까지 키워(Green 법칙) 비율을 곱한 것이다(D-037).
    // 그래서 육지 물이 바다의 파와 같이 오르내린다. 침수 전선이 닿기 전에는 없다(D-034).
    float eta = -1e5;
    if (uWaveOn > 0.5) {
      if (inCoastGrid(d)) eta = waveAtRaw(d);
      else if (aCoast.z > 0.0 && uSimT >= aFlood.y) {
        vec3 cd = vec3(cos(aCoast.y) * sin(aCoast.x), sin(aCoast.y), cos(aCoast.y) * cos(aCoast.x));
        vec2 w = waveAtRaw2(cd);
        if (w.x > -1e4) eta = max(w.x, 0.0) * shoalGain(-w.y, 1.0, max(w.x, 0.0)) * aCoast.z;
      }
    }
    if (eta > aH.y + 0.05) { height = eta * uExag; relief = height; }
    else { height = (aH.y - 20.0) * uExag; relief = height; }
  } else if (water && uWaveOn > 0.5) {
    vec2 w = waveAtRaw2(d);
    float depth = -aH.y;
    // 격자의 마지막 바다 칸(수심 수십 m)에서 이 자리까지 얕아지는 만큼 키운다(D-036). 해안선에서 판정 수위와 같은 값이 된다.
    float gain = w.x < -1e4 ? 1.0 : shoalGain(-w.y, depth, abs(w.x));
    vShoal = gain;
    float eta = max(w.x, -1e4) * gain;
    // 파도 높이의 과장은 지형과 따로 둔다(결정 D-020).
    // 깊은 바다: 진폭이 0.05 m에서 5 m까지 100배 차이 나므로 색과 같은 로그 눈금으로 올린다. 기준 진폭이 uWaveVis만큼 솟는다.
    // 얕은 바다: 지형과 같은 배율(선형). 그래야 해안에서 물이 땅보다 높은지 낮은지가 맞는다.
    float a = eta / uWaveRef;
    float m = log(1.0 + abs(a) * 60.0) / log(61.0);
    float deep = sign(a) * m * uWaveVis;
    float shallow = eta * uExag;
    // uWaveVis가 0이면 실제 비율: 어디서나 땅과 같은 배율이다
    float disp = uWaveVis > 0.0 ? mix(shallow, deep, smoothstep(50.0, 400.0, depth)) : shallow;
    // 과장한 골이 바닥 아래로 내려가지 않게 막는다
    disp = max(disp, aH.y * uExag * 0.5);
    height += disp;
    relief += disp;
  }
  height += uSeaLevel * uExag;
  relief += uSeaLevel * uExag;
  vPos = aRel + d * height;
  vRelief = aRel + d * relief;
  vDir = d;
  vFlood = aFlood;
  vH = aH.x;
  // 메시가 인덱스 없는 삼각형 목록이므로 추가 버퍼 없이 모서리 좌표를 만든다.
  int corner = gl_VertexID % 3;
  vBarycentric = corner == 0 ? vec3(1, 0, 0) : corner == 1 ? vec3(0, 1, 0) : vec3(0, 0, 1);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int; // 정점 셰이더와 같은 유니폼을 쓴다. 정밀도가 다르면 연결에 실패한다.
flat in vec4 vColor;
in vec3 vRelief;
in vec3 vPos;
in vec3 vDir;
in vec2 vFlood;
in float vH;
in vec3 vBarycentric;
uniform float uLineStyle;
in float vShoal;
uniform vec3 uLight;
uniform vec3 uEye;         // 상대 좌표
${WAVE_GLSL}
out vec4 outColor;
void main() {
  // 면 안에서 위치는 선형으로 변하므로 화면 미분으로 구한 법선은 면마다 하나다. 면이 또렷이 갈린다.
  vec3 n = normalize(cross(dFdx(vRelief), dFdy(vRelief)));
  if (dot(n, vDir) < 0.0) n = -n;
  float diff = max(dot(n, uLight), 0.0);
  float shade = 0.50 + 0.62 * diff;
  // 가장자리로 갈수록 조금 어둡게 해서 구의 부피감을 준다
  float facing = clamp(dot(normalize(vDir), normalize(uEye - vPos)), 0.0, 1.0);
  shade *= mix(0.72, 1.0, pow(facing, 0.6));
  vec3 c = vColor.rgb * shade;
  if (uLineStyle > 0.5) {
    bool water = vColor.a > 0.5;
    // 색 등급 대신 불투명 단색 표면과 약한 명암으로 구의 깊이를 남긴다.
    float light = 0.84 + 0.16 * diff;
    c = (water ? vec3(0.035, 0.047, 0.055) : vec3(0.095, 0.11, 0.12)) * light;
    c *= mix(0.65, 1.0, pow(facing, 0.6));
    // 화면상의 삼각형 모서리까지 거리. 가려진 뒷면은 기존 깊이 검사로 숨긴다.
    vec3 px = vBarycentric / max(fwidth(vBarycentric), vec3(1e-5));
    float distancePx = min(px.x, min(px.y, px.z));
    float edge = 1.0 - smoothstep(0.35, 1.0, distancePx);
    float activity = 0.0;
    if (water && uWaveOn > 0.5 && vColor.a > 0.9) {
      float eta = waveAt(normalize(vDir)) * vShoal;
      float magnitude = log(1.0 + abs(eta) / uWaveRef * 60.0) / log(61.0);
      activity = smoothstep(0.08, 0.75, magnitude);
    }
    if (water && vColor.a < 0.9) activity = 0.8;
    if (!water && uFloodOn > 0.5) {
      float fd = floodDepthAt(normalize(vDir));
      if (fd < 0.0 && uSimT >= vFlood.y) fd = vFlood.x - vH;
      if (fd > 0.05) activity = 0.8;
    }
    // 모든 면을 같은 밝기로 채우지 않고, 파도가 있는 모서리에 대비를 모은다.
    float strength = mix(water ? 0.12 : 0.32, 0.95, activity);
    c *= water ? 0.8 : 0.65;
    c = mix(c, vec3(0.82, 0.89, 0.91), edge * strength);
    outColor = vec4(c, 1.0);
    return;
  }
  if (vColor.a < 0.5 && uFloodOn > 0.5) {
    // 지형 면: 잠겼던 땅에 최대 침수심의 색을 입힌다. 해안 격자 안은 직접 계산한 값, 밖은 경험식 판정(D-031).
    float fd = floodDepthAt(normalize(vDir));
    // 경험식 판정은 전선이 닿은 뒤부터 칠한다. 물이 밀려든 자리만 남는다.
    if (fd < 0.0 && uSimT >= vFlood.y) fd = vFlood.x - vH;
    if (fd > 0.05) c = mix(c, floodColor(fd) * (0.55 + 0.45 * shade), 0.8);
  }
  if (vColor.a > 0.5) {
    c += vec3(0.05, 0.07, 0.09) * pow(diff, 6.0);
    if (uWaveOn > 0.5 && vColor.a > 0.9) {
      // 파도의 색은 면이 아니라 픽셀마다 입힌다. 지구 전체를 볼 때는 파장이 면 두세 개 크기라서 면 단위 색으로는 파면이 뭉개진다.
      // 마루는 따뜻한 색, 골은 차가운 색. 작은 진폭도 보이도록 로그 눈금을 쓴다.
      float a = waveAt(normalize(vDir)) * vShoal / uWaveRef;
      float m = clamp(log(1.0 + abs(a) * 60.0) / log(61.0), 0.0, 1.0);
      vec3 tint = a > 0.0 ? vec3(1.0, 0.66, 0.34) : vec3(0.03, 0.42, 0.66);
      c = mix(c, tint * (0.78 + 0.3 * diff), smoothstep(0.08, 0.75, m) * 0.92);
    }
  }
  outColor = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

/** 계산 격자 한 단계의 텍스처. */
export interface WaveLevel {
  state: WebGLTexture;
  bed: WebGLTexture;
  size: [number, number];
  px0: number;
  py0: number;
  world: number;
  /** 표시할 때 곱할 원거리 보정의 기준 거리(m). 0이면 없음. */
  gainRef: number;
}

/** 파도 계산의 결과를 그리기에 넘기는 창구. 단계 0은 전 지구 격자다. 최대 4단계. */
export interface WaveSource {
  levels: WaveLevel[];
  /** 색과 과장의 기준이 되는 진폭(m). 보통 초기 수면 변위의 최댓값이다. */
  refAmp: number;
  /** 발생원의 단위 벡터. 원거리 보정에 쓴다. */
  srcDir: [number, number, number];
  /** 해안 격자의 기록. 최대 침수 범위를 그리는 데 쓴다. */
  flood?: { record: WebGLTexture; bed: WebGLTexture; size: [number, number]; px0: number; py0: number; world: number };
}

export class GlobeRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly program: WebGLProgram;
  private readonly uni: Record<string, WebGLUniformLocation | null> = {};
  private readonly vao: WebGLVertexArrayObject;
  private readonly buffer: WebGLBuffer;
  private capacity = 0;
  private count = 0;
  private origin: Vec3 = [0, 0, 1];
  /** 지형 수직 과장 배율. */
  exaggeration = 40;
  /** 지형과 수면의 표현. 기본값은 색상 방식이다. */
  designStyle: 'color' | 'wireframe' = 'color';
  gpuBytes = 0;
  wave: WaveSource | null = null;
  /** 운석이 충돌하기 전에는 계산용 초기 공동을 화면에 그리지 않는다. */
  wavesVisible = true;
  /** 최대 침수 범위를 지형에 칠할지. */
  floodOn = true;
  /** 계산 시각(s). 경험식 침수 전선을 움직이는 데 쓴다. 계산이 없으면 -1. */
  simTime = -1;
  /** 깊은 바다에서 기준 진폭의 파도가 화면 폭의 이 비율만큼 솟아 보이게 한다. */
  waveHeightFraction = 0.02;
  /**
   * 파도 높이를 그리는 방식(D-032).
   *  real: 어디서나 땅과 같은 배율. 먼 바다에서는 파도가 안 보이고 색으로만 읽힌다.
   *  coastReal: 멀리서는 과장하고, 화면 폭 250 km 아래로 가까워지면 땅과 같은 배율. 눈에 보이는 높이 비교가 정직하다.
   *  boost: 화면 폭 30 km까지 과장을 유지한다. 해안 앞 파도가 땅보다 높아 보일 수 있다.
   */
  seaLevel = 0;
  waveScaleMode: 'real' | 'coastReal' | 'boost' = 'coastReal';
  private readonly dummy: WebGLTexture;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new LocalizedError('error.webgl');
    this.gl = gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aRel');
    gl.bindAttribLocation(p, 1, 'aH');
    gl.bindAttribLocation(p, 2, 'aColor');
    gl.bindAttribLocation(p, 3, 'aFlood');
    gl.bindAttribLocation(p, 4, 'aCoast');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`셰이더 연결 실패: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    for (const name of ['uSeaLevel', 'uLineStyle', 'uViewProj', 'uOrigin', 'uExag', 'uLight', 'uEye', 'uWaveOn', 'uWaveVis', 'uWaveRef', 'uGainSrc', 'uFloodRec', 'uFloodBed', 'uFloodSize', 'uFloodOrigin', 'uFloodWorld', 'uFloodBox', 'uFloodOn', 'uSimT', ...[0, 1, 2, 3].flatMap((k) => [`uL${k}State`, `uL${k}Bed`, `uL${k}Size`, `uL${k}Origin`, `uL${k}World`, `uL${k}On`, `uL${k}Gain`])]) {
      this.uni[name] = gl.getUniformLocation(p, name);
    }
    // 파도가 없을 때 물릴 1×1 텍스처
    this.dummy = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.dummy);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.vao = gl.createVertexArray()!;
    this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, STRIDE, 40);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 2, gl.FLOAT, false, STRIDE, 20);
    gl.enableVertexAttribArray(4);
    gl.vertexAttribPointer(4, 3, gl.FLOAT, false, STRIDE, 28);
    gl.bindVertexArray(null);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
  }

  /** RGBA32F 텍스처를 만든다. 발생원을 놓았을 때 해저 변형이나 공동을 물 면으로 미리 보여 주는 데 쓴다(D-042). */
  makeTexture(w: number, h: number, data: Float32Array): WebGLTexture {
    const gl = this.gl, t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  deleteTexture(t: WebGLTexture): void {
    this.gl.deleteTexture(t);
  }

  /** 새로 만든 메시로 바꾼다. 지형 층과 물 층이 한 버퍼에 이어서 들어 있다. */
  setMesh(mesh: AdaptiveMesh): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (mesh.data.byteLength > this.capacity) {
      // 메시를 만들 때마다 크기가 달라진다. 넉넉히 잡아 두고 그 안에서 덮어쓴다.
      this.capacity = Math.ceil(mesh.data.byteLength * 1.5);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity, gl.DYNAMIC_DRAW);
      this.gpuBytes = this.capacity;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(mesh.data));
    this.count = mesh.terrainVertices + mesh.waterVertices;
    this.origin = mesh.origin;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
  }

  render(cam: GlobeCamera): void {
    const gl = this.gl;
    // 파도 계산이 같은 컨텍스트를 쓰면서 상태를 바꿔 놓는다. 그리기 전에 되돌린다.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (this.count === 0) return;
    gl.useProgram(this.program);
    gl.uniform1f(this.uni.uLineStyle, this.designStyle === 'wireframe' ? 1 : 0);
    const rel = cam.viewProjRelative(this.origin);
    gl.uniformMatrix4fv(this.uni.uViewProj, false, rel.matrix);
    gl.uniform3f(this.uni.uOrigin, this.origin[0], this.origin[1], this.origin[2]);
    gl.uniform3f(this.uni.uEye, rel.eye[0], rel.eye[1], rel.eye[2]);
    gl.uniform1f(this.uni.uSeaLevel, this.seaLevel);
    gl.uniform1f(this.uni.uExag, this.exaggeration / 6371000);
    // 빛은 카메라 기준 왼쪽 위에서 온다. 지구를 돌려도 보이는 쪽이 늘 밝다.
    const { right: r, up: u, forward: f } = cam.basis;
    const l: Vec3 = [-r[0] * 0.55 + u[0] * 0.6 - f[0] * 0.58, -r[1] * 0.55 + u[1] * 0.6 - f[1] * 0.58, -r[2] * 0.55 + u[2] * 0.6 - f[2] * 0.58];
    const ll = Math.hypot(l[0], l[1], l[2]);
    gl.uniform3f(this.uni.uLight, l[0] / ll, l[1] / ll, l[2] / ll);
    const w = this.wavesVisible ? this.wave : null;
    for (let k = 0; k < 4; k++) {
      const lv = w?.levels[k];
      gl.activeTexture(gl.TEXTURE0 + 2 * k);
      gl.bindTexture(gl.TEXTURE_2D, lv ? lv.state : this.dummy);
      gl.activeTexture(gl.TEXTURE0 + 2 * k + 1);
      gl.bindTexture(gl.TEXTURE_2D, lv ? lv.bed : this.dummy);
      gl.uniform1i(this.uni[`uL${k}State`], 2 * k);
      gl.uniform1i(this.uni[`uL${k}Bed`], 2 * k + 1);
      gl.uniform1f(this.uni[`uL${k}On`], lv ? 1 : 0);
      gl.uniform2i(this.uni[`uL${k}Size`], lv ? lv.size[0] : 1, lv ? lv.size[1] : 1);
      gl.uniform2f(this.uni[`uL${k}Origin`], lv ? lv.px0 : 0, lv ? lv.py0 : 0);
      gl.uniform1f(this.uni[`uL${k}World`], lv ? lv.world : 1);
      gl.uniform1f(this.uni[`uL${k}Gain`], lv ? lv.gainRef : 0);
    }
    gl.uniform3f(this.uni.uGainSrc, w ? w.srcDir[0] : 0, w ? w.srcDir[1] : 0, w ? w.srcDir[2] : 1);
    const fl = w?.flood;
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D, fl ? fl.record : this.dummy);
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_2D, fl ? fl.bed : this.dummy);
    gl.uniform1i(this.uni.uFloodRec, 8);
    gl.uniform1i(this.uni.uFloodBed, 9);
    gl.uniform1f(this.uni.uFloodBox, fl ? 1 : 0);
    gl.uniform1f(this.uni.uFloodOn, this.floodOn && this.wavesVisible ? 1 : 0);
    gl.uniform1f(this.uni.uSimT, this.wavesVisible ? this.simTime : -1);
    gl.uniform2i(this.uni.uFloodSize, fl ? fl.size[0] : 1, fl ? fl.size[1] : 1);
    gl.uniform2f(this.uni.uFloodOrigin, fl ? fl.px0 : 0, fl ? fl.py0 : 0);
    gl.uniform1f(this.uni.uFloodWorld, fl ? fl.world : 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1f(this.uni.uWaveOn, w ? 1 : 0);
    gl.uniform1f(this.uni.uWaveRef, w ? w.refAmp : 1);
    // 기준 진폭의 파도가 화면 폭의 일정 비율로 솟아 보이는 높이(반지름 단위). 방식에 따라 가까이 가면 0이 되어 땅과 같은 배율만 남는다.
    const km = cam.viewWidthKm;
    const [fadeFrom, fadeTo] = this.waveScaleMode === 'boost' ? [30, 300] : [250, 1000];
    const t = this.waveScaleMode === 'real' ? 0 : Math.max(0, Math.min(1, (km - fadeFrom) / (fadeTo - fadeFrom)));
    const waveVis = (this.waveHeightFraction * t * t * (3 - 2 * t) * km * 1000) / 6371000;
    gl.uniform1f(this.uni.uWaveVis, waveVis);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    gl.bindVertexArray(null);
  }
}

// 천수방정식 GPU 셰이더. 식은 src/physics/swe-cpu.ts와 같다. 그 파일의 설명을 먼저 읽을 것.
// 상태 텍스처: R = eta, G = u(동쪽 면), B = v(남쪽 면), A = 거품 추적자(렌더링 전용)
// 정적 텍스처: R = 지반 표고, G = Manning n, B = 초기 수위 eta0, A = 처음부터 바다인지(0/1)

export const FULLSCREEN_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uState;
uniform sampler2D uStatic;
uniform ivec2 uSize;
uniform float uDt;
uniform float uDryEps;
uniform float uMaxFroude;
// Mercator 축척. uUniformCell > 0 이면 균일 격자(검증용)로 본다.
uniform float uPy0;
uniform float uWorld;
uniform float uEqCell;
uniform float uUniformCell;

const float G = 9.81;
const float PI = 3.141592653589793;
const float FRICTION_MIN_DEPTH = 0.02;

float cellSize(float row) {
  if (uUniformCell > 0.0) return uUniformCell;
  float psi = PI * (1.0 - 2.0 * (uPy0 + row) / uWorld);
  return uEqCell / cosh(psi);
}
vec4 S(ivec2 p) { return texelFetch(uState, clamp(p, ivec2(0), uSize - 1), 0); }
vec4 T(ivec2 p) { return texelFetch(uStatic, clamp(p, ivec2(0), uSize - 1), 0); }

// 풍상측 수위로 구한 면 수심
float faceDepth(float vel, float etaA, float etaB, float zA, float zB) {
  float zf = max(zA, zB);
  float e = vel > 0.0 ? etaA : (vel < 0.0 ? etaB : max(etaA, etaB));
  return max(e - zf, 0.0);
}
`;

export const MOMENTUM_FRAG = /* glsl */ `${COMMON}
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = S(p);
  vec4 tc = T(p);
  float row = float(p.y);
  float un = 0.0, vn = 0.0;

  if (p.x < uSize.x - 1) {
    vec4 e = S(p + ivec2(1, 0));
    vec4 te = T(p + ivec2(1, 0));
    float hf = faceDepth(c.g, c.r, e.r, tc.r, te.r);
    if (hf > uDryEps) {
      float sj = cellSize(row + 0.5);
      float vbar = 0.25 * (c.b + e.b + S(p + ivec2(0, -1)).b + S(p + ivec2(1, -1)).b);
      float dudx = c.g > 0.0 ? c.g - S(p + ivec2(-1, 0)).g : e.g - c.g;
      float dudy = vbar > 0.0 ? c.g - S(p + ivec2(0, -1)).g : S(p + ivec2(0, 1)).g - c.g;
      float u1 = c.g - uDt * (c.g * dudx + vbar * dudy) / sj - uDt * G * (e.r - c.r) / sj;
      float nm = 0.5 * (tc.g + te.g);
      u1 /= 1.0 + uDt * G * nm * nm * sqrt(c.g * c.g + vbar * vbar) / pow(max(hf, FRICTION_MIN_DEPTH), 4.0 / 3.0);
      float cap = uMaxFroude * sqrt(G * hf);
      un = clamp(u1, -cap, cap);
    }
  }
  if (p.y < uSize.y - 1) {
    vec4 s = S(p + ivec2(0, 1));
    vec4 ts = T(p + ivec2(0, 1));
    float hf = faceDepth(c.b, c.r, s.r, tc.r, ts.r);
    if (hf > uDryEps) {
      float sf = cellSize(row + 1.0);
      float ubar = 0.25 * (c.g + S(p + ivec2(-1, 0)).g + s.g + S(p + ivec2(-1, 1)).g);
      float dvdx = ubar > 0.0 ? c.b - S(p + ivec2(-1, 0)).b : S(p + ivec2(1, 0)).b - c.b;
      float dvdy = c.b > 0.0 ? c.b - S(p + ivec2(0, -1)).b : s.b - c.b;
      float v1 = c.b - uDt * (ubar * dvdx + c.b * dvdy) / sf - uDt * G * (s.r - c.r) / sf;
      float nm = 0.5 * (tc.g + ts.g);
      v1 /= 1.0 + uDt * G * nm * nm * sqrt(c.b * c.b + ubar * ubar) / pow(max(hf, FRICTION_MIN_DEPTH), 4.0 / 3.0);
      float cap = uMaxFroude * sqrt(G * hf);
      vn = clamp(v1, -cap, cap);
    }
  }
  outColor = vec4(c.r, un, vn, c.a);
}
`;

export const CONTINUITY_FRAG = /* glsl */ `${COMMON}
// 경계 처리. 0 = 닫힌 벽, 1 = 스펀지(가장 거친 격자), 2 = 부모 격자로 완화(중첩 격자)
uniform int uBoundaryMode;
uniform float uBandWidth;

// 부모 격자. uParentPrev와 uParentCur 사이를 uParentFrac으로 시간 보간한다.
uniform sampler2D uParentPrev;
uniform sampler2D uParentCur;
uniform sampler2D uParentStatic;
uniform ivec2 uParentSize;
uniform float uParentFrac;
uniform float uParentDryEps;
uniform vec2 uParentOffset;   // 자식 원점의 부모 셀 좌표
uniform float uParentScale;   // 자식 셀 하나가 부모 셀 몇 개인지 (1 / 해상도 비)

// 소행성 원거리 감쇠 보정. 가장 거친 격자의 값을 자식에 넘길 때만 곱한다.
uniform float uGainRef;       // 기준 반지름(m). 0이면 보정 없음
uniform vec2 uGainSrc;        // 발생원의 이 격자 셀 좌표
uniform float uGainSrcCell;   // 발생원 위도에서의 셀 크기(m)

uniform float uFoamDecay;

out vec4 outColor;

vec4 P(sampler2D tex, ivec2 q) { return texelFetch(tex, clamp(q, ivec2(0), uParentSize - 1), 0); }

// 부모의 eta를 젖은 셀만 가중해 쌍선형 보간한다. 마른 셀의 eta는 지반 표고라서 섞으면 안 된다.
vec2 parentEta(vec2 pc) {
  vec2 f = pc - 0.5;
  ivec2 q = ivec2(floor(f));
  vec2 t = f - vec2(q);
  float sum = 0.0, wsum = 0.0;
  for (int dj = 0; dj <= 1; dj++) for (int di = 0; di <= 1; di++) {
    ivec2 qq = q + ivec2(di, dj);
    float w = (di == 0 ? 1.0 - t.x : t.x) * (dj == 0 ? 1.0 - t.y : t.y);
    float z = P(uParentStatic, qq).r;
    float e = mix(P(uParentPrev, qq).r, P(uParentCur, qq).r, uParentFrac);
    if (e - z > uParentDryEps) { sum += w * e; wsum += w; }
  }
  return wsum > 1e-4 ? vec2(sum / wsum, 1.0) : vec2(0.0, 0.0);
}
float parentVel(vec2 idx, int ch) {
  ivec2 q = ivec2(floor(idx));
  vec2 t = idx - vec2(q);
  float a = mix(P(uParentPrev, q)[ch], P(uParentCur, q)[ch], uParentFrac);
  float b = mix(P(uParentPrev, q + ivec2(1, 0))[ch], P(uParentCur, q + ivec2(1, 0))[ch], uParentFrac);
  float c = mix(P(uParentPrev, q + ivec2(0, 1))[ch], P(uParentCur, q + ivec2(0, 1))[ch], uParentFrac);
  float d = mix(P(uParentPrev, q + ivec2(1, 1))[ch], P(uParentCur, q + ivec2(1, 1))[ch], uParentFrac);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = S(p);
  float z = T(p).r;
  float row = float(p.y);
  float sj = cellSize(row + 0.5);

  float fe = 0.0, fw = 0.0, fs = 0.0, fn = 0.0;
  vec4 w = S(p + ivec2(-1, 0));
  vec4 n = S(p + ivec2(0, -1));
  if (p.x < uSize.x - 1) {
    fe = c.g * faceDepth(c.g, c.r, S(p + ivec2(1, 0)).r, z, T(p + ivec2(1, 0)).r);
  }
  if (p.x > 0) fw = w.g * faceDepth(w.g, w.r, c.r, T(p + ivec2(-1, 0)).r, z);
  if (p.y < uSize.y - 1) {
    fs = c.b * faceDepth(c.b, c.r, S(p + ivec2(0, 1)).r, z, T(p + ivec2(0, 1)).r) * cellSize(row + 1.0);
  }
  if (p.y > 0) fn = n.b * faceDepth(n.b, n.r, c.r, T(p + ivec2(0, -1)).r, z) * cellSize(row);

  float eta = c.r - uDt * ((fe - fw) / sj + (fs - fn) / (sj * sj));
  eta = max(eta, z);
  float u = c.g, v = c.b;

  // 거품 추적자: 수면 경사가 급한 곳(단파)과 육지를 빠르게 흐르는 곳에서 생기고 시간이 지나면 사라진다
  float depth = eta - z;
  float slope = length(vec2(S(p + ivec2(1, 0)).r - w.r, S(p + ivec2(0, 1)).r - n.r)) / (2.0 * sj);
  float speed = length(vec2(0.5 * (u + w.g), 0.5 * (v + n.b)));
  float gen = 0.0;
  if (depth > uDryEps) {
    gen = smoothstep(0.006, 0.04, slope) * (1.0 - smoothstep(5.0, 60.0, depth));
    // 육지에서는 아주 빠른 흐름에서만 조금 생긴다. 파면의 거품은 렌더링 단계에서 도달 시각으로 따로 그린다.
    if (T(p).a < 0.5) gen = max(gen, 0.6 * smoothstep(3.0, 8.0, speed));
  }
  float foam = clamp(max(c.a * uFoamDecay, gen), 0.0, 1.0);

  float dEdge = float(min(min(p.x, p.y), min(uSize.x - 1 - p.x, uSize.y - 1 - p.y)));
  if (uBoundaryMode == 1 && dEdge < uBandWidth) {
    float tt = (uBandWidth - dEdge) / uBandWidth;
    float sp = 1.0 - 0.12 * tt * tt;
    if (depth > uDryEps) eta = max(eta * sp, z);
    u *= sp; v *= sp;
  } else if (uBoundaryMode == 2 && dEdge < uBandWidth) {
    float tt = (uBandWidth - dEdge) / uBandWidth;
    float alpha = tt * tt;
    vec2 cc = vec2(p) + 0.5;
    float gain = 1.0;
    if (uGainRef > 0.0) {
      vec2 d = cc - uGainSrc;
      float r = length(d) * 0.5 * (sj + uGainSrcCell);
      gain = min(1.0, sqrt(uGainRef / max(r, 1.0)));
    }
    vec2 pe = parentEta(uParentOffset + cc * uParentScale);
    if (pe.y > 0.5) {
      float target = max(pe.x * gain, z);
      eta = mix(eta, target, alpha);
    }
    float pu = parentVel(uParentOffset + vec2(cc.x + 0.5, cc.y) * uParentScale - vec2(1.0, 0.5), 1) * gain;
    float pv = parentVel(uParentOffset + vec2(cc.x, cc.y + 0.5) * uParentScale - vec2(0.5, 1.0), 2) * gain;
    // 마른 면의 유속은 다음 운동량 단계에서 0으로 되돌아가므로 그대로 섞어도 안전하다
    u = mix(u, pu, alpha);
    v = mix(v, pv, alpha);
  }
  outColor = vec4(eta, u, v, foam);
}
`;

// 기록 텍스처: R = 최대 수위, G = 첫 도달 시각(s, 없으면 -1), B = 최대 유속, A = 최대 운동량 플럭스 h|U|²
export const RECORD_FRAG = /* glsl */ `${COMMON}
uniform sampler2D uRecord;
uniform float uTime;
uniform float uArrivalThreshold;
uniform float uGainRef;
uniform vec2 uGainSrc;
uniform float uGainSrcCell;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = S(p);
  vec4 t = T(p);
  vec4 r = texelFetch(uRecord, p, 0);
  float depth = c.r - t.r;
  float gain = 1.0;
  if (uGainRef > 0.0) {
    vec2 d = vec2(p) + 0.5 - uGainSrc;
    float rr = length(d) * 0.5 * (cellSize(float(p.y) + 0.5) + uGainSrcCell);
    gain = min(1.0, sqrt(uGainRef / max(rr, 1.0)));
  }
  if (depth > uDryEps) {
    float uc = 0.5 * (c.g + S(p + ivec2(-1, 0)).g);
    float vc = 0.5 * (c.b + S(p + ivec2(0, -1)).b);
    float sp = length(vec2(uc, vc)) * gain;
    bool sea = t.a > 0.5;
    float level = sea ? c.r * gain : c.r;
    r.r = max(r.r, level);
    r.b = max(r.b, sp);
    r.a = max(r.a, depth * sp * sp);
    if (r.g < 0.0) {
      bool hit = sea ? abs(c.r - t.b) * gain > uArrivalThreshold : depth > max(uDryEps, 0.03);
      if (hit) r.g = uTime;
    }
  }
  outColor = r;
}
`;

// 렌더링용 수면. 마른 셀에는 이웃한 젖은 셀의 수위를 한 칸 번지게 해서, 물 메시가 지형과 자연스럽게 만나게 한다.
// R = 그릴 수위, G = 젖음(1) / 번진 셀(0.5) / 없음(0), B = 수심, A = 거품
export const RENDER_ETA_FRAG = /* glsl */ `${COMMON}
uniform float uGainRef;
uniform vec2 uGainSrc;
uniform float uGainSrcCell;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = S(p);
  float z = T(p).r;
  float depth = c.r - z;
  float gain = 1.0;
  if (uGainRef > 0.0) {
    vec2 d = vec2(p) + 0.5 - uGainSrc;
    float rr = length(d) * 0.5 * (cellSize(float(p.y) + 0.5) + uGainSrcCell);
    gain = min(1.0, sqrt(uGainRef / max(rr, 1.0)));
  }
  if (depth > uDryEps) {
    outColor = vec4(T(p).a > 0.5 ? c.r * gain : c.r, 1.0, depth, c.a);
    return;
  }
  float sum = 0.0, cnt = 0.0, foam = 0.0;
  for (int dj = -1; dj <= 1; dj++) for (int di = -1; di <= 1; di++) {
    ivec2 q = p + ivec2(di, dj);
    if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    vec4 s = texelFetch(uState, q, 0);
    float zz = texelFetch(uStatic, q, 0).r;
    if (s.r - zz > uDryEps) { sum += s.r; cnt += 1.0; foam += s.a; }
  }
  // 마른 셀의 수면은 지반 바로 아래에 둔다. 물 메시가 지형과 만나는 선이 해안선이 된다.
  if (cnt > 0.0) outColor = vec4(min(sum / cnt, z - 0.01), 0.5, 0.0, foam / cnt);
  else outColor = vec4(z - 5.0, 0.0, 0.0, 0.0);
}
`;

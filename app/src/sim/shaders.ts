// 천수방정식 GPU 셰이더. 식은 ../physics/swe-cpu.ts(CPU 기준 구현)와 같고, 프로토타입 2의 셰이더에서 옮겨 왔다.
// 달라진 점: three.js 없이 돈다. 경도 방향 순환 경계(uWrapX)가 있다. 전 지구 격자는 동서로 이어져야 한다.
// 상태 텍스처: R = 수위 eta, G = u(동쪽 면 유속), B = v(남쪽 면 유속), A = 안 씀
// 정적 텍스처: R = 지반 표고, G = Manning n, B = 초기 수위, A = 처음부터 바다인지(0/1)
// 행 0이 북쪽이다. v는 남쪽이 양수다.

export const VERT = /* glsl */ `#version 300 es
in vec2 position;
void main() { gl_Position = vec4(position, 0.0, 1.0); }
`;

const COMMON = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uState;
uniform sampler2D uStatic;
uniform ivec2 uSize;
uniform float uDt;
uniform float uDryEps;
uniform float uMaxFroude;
uniform int uWrapX;
// Mercator 축척. uUniformCell > 0 이면 균일 격자(검증용)로 본다.
uniform float uPy0;
uniform float uPx0;
uniform float uWorld;
uniform float uEqCell;
uniform float uUniformCell;
// 소행성 원거리 감쇠 보정. 발생원에서 기준 거리 밖은 √(기준/r)를 곱한다. 0이면 없음.
// uGainRef는 이 격자의 기록에, uGainRelaxRef는 부모 값을 받을 때 쓴다. 보정 안 된 격자(전 지구, 발생원)는 기록에,
// 그 격자를 부모로 둔 자식은 받을 때 곱한다. 자식의 안쪽은 그렇게 보정된 값으로 채워지므로 기록에는 다시 곱하지 않는다.
uniform float uGainRef;
uniform float uGainRelaxRef;
uniform vec3 uGainSrc;

const float G = 9.81;
const float PI = 3.141592653589793;
const float FRICTION_MIN_DEPTH = 0.02;

float cellSize(float row) {
  if (uUniformCell > 0.0) return uUniformCell;
  float psi = PI * (1.0 - 2.0 * (uPy0 + row) / uWorld);
  return uEqCell / cosh(psi);
}
// 셀 (i, j)의 발생원까지 거리에 따른 보정 배율
float gainAt(ivec2 p, float ref) {
  if (ref <= 0.0) return 1.0;
  float lon = ((uPx0 + float(p.x) + 0.5) / uWorld) * 2.0 * PI - PI;
  float lat = atan(sinh(PI * (1.0 - 2.0 * (uPy0 + float(p.y) + 0.5) / uWorld)));
  vec3 d = vec3(cos(lat) * sin(lon), sin(lat), cos(lat) * cos(lon));
  float r = acos(clamp(dot(d, uGainSrc), -1.0, 1.0)) * 6371000.0;
  return min(1.0, sqrt(ref / max(r, 1.0)));
}
ivec2 wrap(ivec2 p) {
  int x = uWrapX == 1 ? ((p.x % uSize.x) + uSize.x) % uSize.x : clamp(p.x, 0, uSize.x - 1);
  return ivec2(x, clamp(p.y, 0, uSize.y - 1));
}
vec4 S(ivec2 p) { return texelFetch(uState, wrap(p), 0); }
vec4 T(ivec2 p) { return texelFetch(uStatic, wrap(p), 0); }
bool hasEast(ivec2 p) { return uWrapX == 1 || p.x < uSize.x - 1; }
bool hasWest(ivec2 p) { return uWrapX == 1 || p.x > 0; }

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

  if (hasEast(p)) {
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
  outColor = vec4(c.r, un, vn, 0.0);
}
`;

export const CONTINUITY_FRAG = /* glsl */ `${COMMON}
// 경계 처리. 0 = 닫힌 벽, 1 = 스펀지(파도를 흡수한다. 순환 격자에서는 남북 가장자리에만), 2 = 부모 격자로 완화(중첩 격자)
uniform int uBoundaryMode;
uniform float uBandWidth;

// 부모 격자. uParentPrev와 uParentCur 사이를 uParentFrac으로 시간 보간한다.
uniform sampler2D uParentPrev;
uniform sampler2D uParentCur;
uniform sampler2D uParentStatic;
uniform ivec2 uParentSize;
uniform int uParentWrapX;
uniform float uParentFrac;
uniform float uParentDryEps;
uniform vec2 uParentOffset;   // 자식 원점의 부모 셀 좌표
uniform float uParentScale;   // 자식 셀 하나가 부모 셀 몇 개인지 (1 / 해상도 비)
out vec4 outColor;

vec4 P(sampler2D tex, ivec2 q) {
  int x = uParentWrapX == 1 ? ((q.x % uParentSize.x) + uParentSize.x) % uParentSize.x : clamp(q.x, 0, uParentSize.x - 1);
  return texelFetch(tex, ivec2(x, clamp(q.y, 0, uParentSize.y - 1)), 0);
}
// 부모의 수위를 젖은 셀만 가중해 쌍선형 보간한다. 마른 셀의 수위는 지반 표고라서 섞으면 안 된다.
vec2 parentEta(vec2 pc) {
  vec2 f = pc - 0.5;
  ivec2 q = ivec2(floor(f));
  vec2 t = f - vec2(q);
  float sum = 0.0, wsum = 0.0;
  for (int dj = 0; dj <= 1; dj++) for (int di = 0; di <= 1; di++) {
    ivec2 qq = q + ivec2(di, dj);
    float w = (di == 0 ? 1.0 - t.x : t.x) * (dj == 0 ? 1.0 - t.y : t.y);
    float zb = P(uParentStatic, qq).r;
    float e = mix(P(uParentPrev, qq).r, P(uParentCur, qq).r, uParentFrac);
    if (e - zb > uParentDryEps) { sum += w * e; wsum += w; }
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
  if (hasEast(p)) fe = c.g * faceDepth(c.g, c.r, S(p + ivec2(1, 0)).r, z, T(p + ivec2(1, 0)).r);
  if (hasWest(p)) fw = w.g * faceDepth(w.g, w.r, c.r, T(p + ivec2(-1, 0)).r, z);
  if (p.y < uSize.y - 1) fs = c.b * faceDepth(c.b, c.r, S(p + ivec2(0, 1)).r, z, T(p + ivec2(0, 1)).r) * cellSize(row + 1.0);
  if (p.y > 0) fn = n.b * faceDepth(n.b, n.r, c.r, T(p + ivec2(0, -1)).r, z) * cellSize(row);

  float eta = max(c.r - uDt * ((fe - fw) / sj + (fs - fn) / (sj * sj)), z);
  float u = c.g, v = c.b;

  int dy = min(p.y, uSize.y - 1 - p.y);
  int dx = uWrapX == 1 ? 1000000 : min(p.x, uSize.x - 1 - p.x);
  float dEdge = float(min(dx, dy));
  if (uBoundaryMode == 1 && dEdge < uBandWidth) {
    float tt = (uBandWidth - dEdge) / uBandWidth;
    float sp = 1.0 - 0.12 * tt * tt;
    if (eta - z > uDryEps) eta = max(eta * sp, z);
    u *= sp; v *= sp;
  } else if (uBoundaryMode == 2 && dEdge < uBandWidth) {
    // 가장자리에서 1, 안쪽으로 제곱으로 줄어드는 가중치로 부모 값에 끌어당긴다
    float tt = (uBandWidth - dEdge) / uBandWidth;
    float alpha = tt * tt;
    vec2 cc = vec2(p) + 0.5;
    float gain = gainAt(p, uGainRelaxRef);
    vec2 pe = parentEta(uParentOffset + cc * uParentScale);
    if (pe.y > 0.5) eta = mix(eta, max(pe.x * gain, z), alpha);
    float pu = parentVel(uParentOffset + vec2(cc.x + 0.5, cc.y) * uParentScale - vec2(1.0, 0.5), 1) * gain;
    float pv = parentVel(uParentOffset + vec2(cc.x, cc.y + 0.5) * uParentScale - vec2(0.5, 1.0), 2) * gain;
    // 마른 면의 유속은 다음 운동량 단계에서 0으로 되돌아가므로 그대로 섞어도 안전하다
    u = mix(u, pu, alpha);
    v = mix(v, pv, alpha);
  }
  outColor = vec4(eta, u, v, 0.0);
}
`;

// 기록 텍스처: R = 최대 수위, G·B·A = 초기 수위에서 0.02 m, 0.3 m, 1.5 m 벗어난 첫 시각(s, 없으면 -1)
// 문턱값이 하나면 발생원 가까이에서 초기 변형이 움직이기만 해도 찍혀 너무 이르다. 판정은 최대 수위에 맞는 문턱값의 시각을 고른다(D-034).
export const RECORD_FRAG = /* glsl */ `${COMMON}
uniform sampler2D uRecord;
uniform float uTime;
uniform vec3 uArrivalThresholds;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = S(p);
  vec4 t = T(p);
  vec4 r = texelFetch(uRecord, p, 0);
  if (c.r - t.r > uDryEps) {
    // 보정은 바다 셀에만. 육지 위의 물은 수위가 지반과 비교되는 절대값이라 배율을 곱할 수 없다.
    float gain = t.a > 0.5 ? gainAt(p, uGainRef) : 1.0;
    r.r = max(r.r, t.a > 0.5 ? c.r * gain : c.r);
    float dev = abs(c.r - t.b) * gain;
    if (r.g < 0.0 && dev > uArrivalThresholds.x) r.g = uTime;
    if (r.b < 0.0 && dev > uArrivalThresholds.y) r.b = uTime;
    if (r.a < 0.0 && dev > uArrivalThresholds.z) r.a = uTime;
  }
  outColor = r;
}
`;

// 렌더링 셰이더가 함께 쓰는 GLSL 조각.

export const BILINEAR = /* glsl */ `
vec4 bilinear(sampler2D tex, vec2 texel, ivec2 size) {
  vec2 f = texel - 0.5;
  ivec2 q = ivec2(floor(f));
  vec2 t = f - vec2(q);
  ivec2 mx = size - 1;
  vec4 a = texelFetch(tex, clamp(q, ivec2(0), mx), 0);
  vec4 b = texelFetch(tex, clamp(q + ivec2(1, 0), ivec2(0), mx), 0);
  vec4 c = texelFetch(tex, clamp(q + ivec2(0, 1), ivec2(0), mx), 0);
  vec4 d = texelFetch(tex, clamp(q + ivec2(1, 1), ivec2(0), mx), 0);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
`;

export const SKY = /* glsl */ `
uniform vec3 uSunDir;
vec3 skyColor(vec3 dir) {
  float h = clamp(dir.y, -0.1, 1.0);
  vec3 horizon = vec3(0.80, 0.87, 0.93);
  vec3 zenith = vec3(0.30, 0.50, 0.78);
  vec3 c = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
  float sun = max(dot(normalize(dir), uSunDir), 0.0);
  c += vec3(1.0, 0.85, 0.6) * (pow(sun, 350.0) * 2.0 + pow(sun, 12.0) * 0.18);
  return c;
}
vec3 applyFog(vec3 color, float dist, float density) {
  float f = 1.0 - exp(-dist * density);
  return mix(color, vec3(0.80, 0.87, 0.93), clamp(f, 0.0, 0.85));
}
`;

// 자식 격자가 덮는 영역은 부모에서 그리지 않는다. uChildRect = (i0, j0, i1, j1) 부모 셀 좌표.
export const CHILD_CUT = /* glsl */ `
uniform vec4 uChildRect;
uniform float uHasChild;
bool insideChild(vec2 texel) {
  if (uHasChild < 0.5) return false;
  const float inset = 0.6;
  return texel.x > uChildRect.x + inset && texel.x < uChildRect.z - inset &&
         texel.y > uChildRect.y + inset && texel.y < uChildRect.w - inset;
}
`;

export const NOISE = /* glsl */ `
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), u.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
`;

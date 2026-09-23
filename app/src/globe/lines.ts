import type { EarthGrid } from '../data/earth';
import type { Polyline } from '../data/lines-codec';
import type { GlobeCamera } from './camera';
import { lonLatToDir } from './icosphere';

/**
 * 실제 경계선(해안선, 국경)을 지구 위에 얇은 선으로 겹쳐 그린다. 지형은 면으로 된 채 두고 선만 올린다.
 * WebGL의 선 굵기는 1 px뿐이라, 선분마다 화면에서 폭이 일정한 띠(삼각형 둘)를 만든다.
 * 꼭짓점 32바이트: 이 끝점의 단위 벡터(f32×3), 반대 끝점(f32×3), 옆쪽(-1/1), 이 점의 표고(m).
 * 깊이 검사를 끄고 지형 위에 늘 보이게 하며, 지평선 너머는 셰이더에서 버린다.
 */

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 aP;
in vec3 aQ;
in float aSide;
in float aElev;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uExag;
uniform vec2 uViewport;
uniform float uWidthPx;
out float vFacing;
void main() {
  vec3 p = aP * (1.0 + max(aElev, 0.0) * uExag + 0.00002);
  vec3 q = aQ * (1.0 + max(aElev, 0.0) * uExag + 0.00002);
  vec4 cp = uViewProj * vec4(p, 1.0);
  vec4 cq = uViewProj * vec4(q, 1.0);
  vec2 sp = cp.xy / max(cp.w, 1e-6) * uViewport;
  vec2 sq = cq.xy / max(cq.w, 1e-6) * uViewport;
  vec2 dir = sq - sp;
  float len = length(dir);
  // 화면에서 1 px보다 짧은 선분은 그리지 않는다. 멀리서 보면 한 픽셀에 선분 여러 개가 다른 방향으로 겹쳐 띠가 뭉개진다.
  // 빠진 자리는 1 px 아래라 거의 보이지 않는다.
  if (len < 1.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vFacing = -1.0; return; }
  vec2 n = vec2(-dir.y, dir.x) / len;
  vec2 off = n * aSide * uWidthPx / uViewport;
  gl_Position = vec4(cp.xy + off * cp.w, cp.z, cp.w);
  // 지평선 너머인가: 눈에서 본 각으로 판정한다
  float e = length(uEye);
  vFacing = dot(aP, uEye / e) - 1.0 / e;
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in float vFacing;
uniform vec4 uColor;
out vec4 outColor;
void main() {
  if (vFacing < 0.0) discard;
  float a = uColor.a * smoothstep(0.0, 0.03, vFacing);
  outColor = vec4(uColor.rgb * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`경계선 셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

const STRIDE = 32;

/**
 * Douglas–Peucker 단순화. 허용 오차는 도 단위이고 경도는 위도의 코사인으로 줄여 잰다.
 * 멀리서 볼 때 점이 픽셀보다 촘촘하면 짧은 띠들이 겹쳐 선이 뭉개지므로, 보는 거리마다 솎아낸 선을 따로 둔다.
 */
export function simplify(coords: Float32Array, tolDeg: number): Float32Array {
  const n = coords.length / 2;
  if (n <= 2 || tolDeg <= 0) return coords;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const tol2 = tolDeg * tolDeg;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const ax = coords[a * 2], ay = coords[a * 2 + 1], bx = coords[b * 2], by = coords[b * 2 + 1];
    const c = Math.cos(((ay + by) / 2) * (Math.PI / 180));
    const dx = (bx - ax) * c, dy = by - ay, l2 = dx * dx + dy * dy;
    let best = -1, bestD = 0;
    for (let i = a + 1; i < b; i++) {
      const px = (coords[i * 2] - ax) * c, py = coords[i * 2 + 1] - ay;
      let d: number;
      if (l2 < 1e-12) d = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
        const ex = px - t * dx, ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > bestD) { bestD = d; best = i; }
    }
    if (bestD > tol2) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m += keep[i];
  const out = new Float32Array(m * 2);
  for (let i = 0, o = 0; i < n; i++) if (keep[i]) { out[o++] = coords[i * 2]; out[o++] = coords[i * 2 + 1]; }
  return out;
}

interface Batch {
  vao: WebGLVertexArrayObject; vbo: WebGLBuffer; ibo: WebGLBuffer; count: number; color: [number, number, number, number]; widthPx: number;
  kind: string;
  /** 이 묶음을 그리는 화면 폭(km)의 범위. [min, max). */
  minViewKm: number;
  maxViewKm: number;
}

export class LineLayer {
  private readonly program: WebGLProgram;
  private readonly uni: Record<string, WebGLUniformLocation | null> = {};
  private batches: Batch[] = [];
  visible = true;
  gpuBytes = 0;

  constructor(private readonly gl: WebGL2RenderingContext) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aP');
    gl.bindAttribLocation(p, 1, 'aQ');
    gl.bindAttribLocation(p, 2, 'aSide');
    gl.bindAttribLocation(p, 3, 'aElev');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`경계선 셰이더 연결 실패: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    for (const n of ['uViewProj', 'uEye', 'uExag', 'uViewport', 'uWidthPx', 'uColor']) this.uni[n] = gl.getUniformLocation(p, n);
  }

  /** 선 목록을 GPU에 올린다. 같은 종류를 다시 올리면 이전 것을 버린다. */
  /**
   * 선 목록을 tolDeg로 솎아 GPU에 올린다. 화면 폭이 [minViewKm, maxViewKm) 안일 때만 그린다. 같은 종류와 범위를 다시 올리면 이전 것을 버린다.
   * followTerrain이 false면 해수면 높이에 그린다. 해안선은 정의상 해수면이라 표고를 따르게 하면 39 km 격자의 육지·바다 셀을 번갈아 밟아 톱니가 생긴다.
   */
  setLines(kind: string, src: Polyline[], earth: EarthGrid, style: { color: [number, number, number, number]; widthPx: number; followTerrain: boolean }, tolDeg: number, minViewKm: number, maxViewKm: number): void {
    this.remove(kind, minViewKm, maxViewKm);
    const { color, widthPx, followTerrain } = style;
    const lines = src.map((l) => ({ coords: simplify(l.coords, tolDeg) }));
    let segs = 0;
    for (const l of lines) segs += Math.max(0, l.coords.length / 2 - 1);
    const data = new ArrayBuffer(segs * 4 * STRIDE);
    const f32 = new Float32Array(data);
    const idx = new Uint32Array(segs * 6);
    let v = 0, s = 0;
    for (const l of lines) {
      const n = l.coords.length / 2;
      for (let i = 0; i + 1 < n; i++) {
        const a = lonLatToDir(l.coords[i * 2], l.coords[i * 2 + 1]), b = lonLatToDir(l.coords[i * 2 + 2], l.coords[i * 2 + 3]);
        const ea = followTerrain ? earth.elevAt(l.coords[i * 2], l.coords[i * 2 + 1]) : 0, eb = followTerrain ? earth.elevAt(l.coords[i * 2 + 2], l.coords[i * 2 + 3]) : 0;
        for (const [pp, qq, side, el] of [[a, b, -1, ea], [a, b, 1, ea], [b, a, 1, eb], [b, a, -1, eb]] as [number[], number[], number, number][]) {
          const o = v * 8;
          f32[o] = pp[0]; f32[o + 1] = pp[1]; f32[o + 2] = pp[2];
          f32[o + 3] = qq[0]; f32[o + 4] = qq[1]; f32[o + 5] = qq[2];
          f32[o + 6] = side; f32[o + 7] = el;
          v++;
        }
        const b0 = v - 4;
        idx[s * 6] = b0; idx[s * 6 + 1] = b0 + 1; idx[s * 6 + 2] = b0 + 2;
        idx[s * 6 + 3] = b0; idx[s * 6 + 4] = b0 + 2; idx[s * 6 + 5] = b0 + 3;
        s++;
      }
    }
    const gl = this.gl;
    const vao = gl.createVertexArray()!, vbo = gl.createBuffer()!, ibo = gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, STRIDE, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 24);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 28);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.batches.push({ vao, vbo, ibo, count: segs * 6, color, widthPx, kind, minViewKm, maxViewKm });
    this.gpuBytes += data.byteLength + idx.byteLength;
  }

  /** 종류가 같고 화면 폭 범위가 겹치는 묶음을 버린다. */
  remove(kind: string, minViewKm = 0, maxViewKm = Infinity): void {
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const b = this.batches[i];
      if (b.kind !== kind || b.maxViewKm <= minViewKm || b.minViewKm >= maxViewKm) continue;
      this.gl.deleteVertexArray(b.vao); this.gl.deleteBuffer(b.vbo); this.gl.deleteBuffer(b.ibo);
      this.batches.splice(i, 1);
    }
  }

  has(kind: string): boolean {
    return this.batches.some((b) => b.kind === kind);
  }

  /** 지구를 그린 뒤에 부른다. 화면 폭에 맞는 묶음만 그린다. */
  render(cam: GlobeCamera, exagPerMeter: number, dpr: number): void {
    if (!this.visible || this.batches.length === 0) return;
    const viewKm = cam.viewWidthKm;
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(this.uni.uViewProj, false, cam.viewProj);
    gl.uniform3f(this.uni.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform1f(this.uni.uExag, exagPerMeter);
    gl.uniform2f(this.uni.uViewport, gl.drawingBufferWidth / 2, gl.drawingBufferHeight / 2);
    for (const b of this.batches) {
      if (viewKm < b.minViewKm || viewKm >= b.maxViewKm) continue;
      gl.uniform1f(this.uni.uWidthPx, b.widthPx * dpr);
      gl.uniform4f(this.uni.uColor, b.color[0], b.color[1], b.color[2], b.color[3]);
      gl.bindVertexArray(b.vao);
      gl.drawElements(gl.TRIANGLES, b.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
  }
}

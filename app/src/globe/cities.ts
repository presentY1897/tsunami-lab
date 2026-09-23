import type { Locale } from '../i18n';
import type { EarthGrid } from '../data/earth';
import type { GlobeCamera } from './camera';
import { lonLatToDir } from './icosphere';

export interface City {
  name: string;
  nameKo?: string;
  nameEn?: string;
  lon: number;
  lat: number;
  /** 인구(천 명). */
  popK: number;
  /** 0이 가장 큰 도시, 1은 수도. */
  rank: number;
  dir: [number, number, number];
}

/**
 * 주요 도시. 점은 WebGL 점 스프라이트로, 이름은 HTML 글자로 그린다.
 * 보는 거리에 따라 인구 기준을 올려 지구 전체를 볼 때는 큰 도시만 보인다. 이름은 화면 안에서 인구가 큰 순으로 겹치지 않게 몇 개만 단다.
 */

const VERT = /* glsl */ `#version 300 es
precision highp float;
in vec3 aDir;
in float aElev;
in float aPopK;
uniform mat4 uViewProj;
uniform vec3 uEye;
uniform float uExag;
uniform float uMinPopK;
uniform float uDpr;
out float vFacing;
out float vBig;
void main() {
  vec3 p = aDir * (1.0 + max(aElev, 0.0) * uExag + 0.00003);
  gl_Position = uViewProj * vec4(p, 1.0);
  float e = length(uEye);
  vFacing = dot(aDir, uEye / e) - 1.0 / e;
  bool show = aPopK >= uMinPopK;
  vBig = clamp((log(max(aPopK, 1.0)) - log(uMinPopK)) / 3.0, 0.0, 1.0);
  gl_PointSize = show ? (5.0 + 4.0 * vBig) * uDpr : 0.0;
  if (!show) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
in float vFacing;
in float vBig;
out vec4 outColor;
void main() {
  if (vFacing < 0.0) discard;
  vec2 c = gl_PointCoord - 0.5;
  float r = length(c) * 2.0;
  if (r > 1.0) discard;
  float ring = smoothstep(0.55, 0.7, r);
  vec3 col = mix(vec3(1.0, 0.95, 0.80), vec3(0.08, 0.10, 0.14), ring);
  float a = (1.0 - smoothstep(0.9, 1.0, r)) * smoothstep(0.0, 0.03, vFacing);
  outColor = vec4(col * a, a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`도시 셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

/** 화면 폭(km)에 따른 인구 기준(천 명). 넓게 볼수록 큰 도시만 남긴다. */
export function minPopKFor(viewKm: number): number {
  if (viewKm > 8000) return 3000;
  if (viewKm > 3000) return 1000;
  if (viewKm > 1200) return 400;
  if (viewKm > 400) return 150;
  return 0;
}

export class CityLayer {
  cities: City[] = [];
  visible = true;
  private readonly program: WebGLProgram;
  private readonly uni: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private readonly labels: HTMLDivElement[] = [];

  constructor(private readonly gl: WebGL2RenderingContext, labelRoot: HTMLElement, private readonly maxLabels = 14) {
    const p = gl.createProgram()!;
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.bindAttribLocation(p, 0, 'aDir');
    gl.bindAttribLocation(p, 1, 'aElev');
    gl.bindAttribLocation(p, 2, 'aPopK');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`도시 셰이더 연결 실패: ${gl.getProgramInfoLog(p)}`);
    this.program = p;
    for (const n of ['uViewProj', 'uEye', 'uExag', 'uMinPopK', 'uDpr']) this.uni[n] = gl.getUniformLocation(p, n);
    for (let i = 0; i < maxLabels; i++) {
      const d = document.createElement('div');
      d.className = 'citylabel';
      d.hidden = true;
      labelRoot.appendChild(d);
      this.labels.push(d);
    }
  }

  setCities(list: { name: string; nameEn?: string; lon: number; lat: number; popK: number; rank: number }[], earth: EarthGrid): void {
    this.cities = list.map((c) => ({ ...c, nameKo: c.name, dir: lonLatToDir(c.lon, c.lat) }));
    const n = this.cities.length;
    const data = new Float32Array(n * 5);
    this.cities.forEach((c, i) => {
      data[i * 5] = c.dir[0]; data[i * 5 + 1] = c.dir[1]; data[i * 5 + 2] = c.dir[2];
      data[i * 5 + 3] = earth.elevAt(c.lon, c.lat);
      data[i * 5 + 4] = c.popK;
    });
    const gl = this.gl;
    if (this.vao) { gl.deleteVertexArray(this.vao); gl.deleteBuffer(this.vbo); }
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 12);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
    gl.bindVertexArray(null);
  }

  setLocale(locale: Locale): void {
    for (const city of this.cities) city.name = locale === 'en' ? city.nameEn || city.nameKo || city.name : city.nameKo || city.name;
  }

  /** 지구를 그린 뒤에 부른다. 점을 그리고 이름표를 놓는다. */
  render(cam: GlobeCamera, exagPerMeter: number, dpr: number): void {
    if (!this.visible || !this.vao) { for (const l of this.labels) l.hidden = true; return; }
    const gl = this.gl;
    const minPop = minPopKFor(cam.viewWidthKm);
    gl.useProgram(this.program);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniformMatrix4fv(this.uni.uViewProj, false, cam.viewProj);
    gl.uniform3f(this.uni.uEye, cam.eye[0], cam.eye[1], cam.eye[2]);
    gl.uniform1f(this.uni.uExag, exagPerMeter);
    gl.uniform1f(this.uni.uMinPopK, minPop);
    gl.uniform1f(this.uni.uDpr, dpr);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.cities.length);
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    this.placeLabels(cam, minPop);
  }

  /** 화면 안의 도시를 인구 순으로 훑으며, 이미 놓인 이름표와 겹치지 않는 것만 단다. */
  private placeLabels(cam: GlobeCamera, minPop: number): void {
    const placed: [number, number][] = [];
    let used = 0;
    const eye = cam.eye, e = Math.hypot(eye[0], eye[1], eye[2]);
    for (const c of this.cities) {
      if (used >= this.maxLabels) break;
      if (c.popK < minPop) continue;
      if ((c.dir[0] * eye[0] + c.dir[1] * eye[1] + c.dir[2] * eye[2]) / e < 1 / e + 0.02) continue;
      const p = cam.project(c.lon, c.lat);
      if (!p || p[0] < 8 || p[1] < 40 || p[0] > cam.width - 8 || p[1] > cam.height - 8) continue;
      if (placed.some(([x, y]) => Math.abs(x - p[0]) < 90 && Math.abs(y - p[1]) < 24)) continue;
      placed.push(p);
      const d = this.labels[used++];
      d.hidden = false;
      d.textContent = c.name;
      d.style.transform = `translate(${(p[0] + 6).toFixed(1)}px, ${(p[1] - 9).toFixed(1)}px)`;
    }
    for (let i = used; i < this.labels.length; i++) this.labels[i].hidden = true;
  }
}

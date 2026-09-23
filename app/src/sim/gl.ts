import { LocalizedError } from '../i18n';
// 프래그먼트 셰이더로 격자 계산을 돌리는 최소한의 도구. 지구를 그리는 것과 같은 WebGL2 컨텍스트를 쓴다.
// 그래야 계산 결과 텍스처를 복사 없이 바로 그리기에 쓸 수 있다.
import { VERT } from './shaders';

export type UniformValue = number | number[] | WebGLTexture;

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
}

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, { loc: WebGLUniformLocation; type: number }>;
}

export class GpuGrid {
  private readonly vao: WebGLVertexArrayObject;
  private readonly programs = new Map<string, Program>();

  constructor(readonly gl: WebGL2RenderingContext) {
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new LocalizedError('error.float');
    }
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private program(frag: string): Program {
    let p = this.programs.get(frag);
    if (p) return p;
    const gl = this.gl;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`계산 셰이더 컴파일 실패: ${gl.getShaderInfoLog(sh)}`);
      return sh;
    };
    const program = gl.createProgram()!;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(program, 0, 'position');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`계산 셰이더 연결 실패: ${gl.getProgramInfoLog(program)}`);
    const uniforms = new Map<string, { loc: WebGLUniformLocation; type: number }>();
    const n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(program, i)!;
      uniforms.set(info.name, { loc: gl.getUniformLocation(program, info.name)!, type: info.type });
    }
    p = { program, uniforms };
    this.programs.set(frag, p);
    return p;
  }

  /** RGBA32F 텍스처. 보간 없이 셀 값을 그대로 읽는다. */
  texture(width: number, height: number, data: Float32Array | null = null): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  target(width: number, height: number, data: Float32Array | null = null): Target {
    const gl = this.gl;
    const tex = this.texture(width, height, data);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('계산용 렌더 타깃을 만들지 못했습니다.');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, width, height };
  }

  upload(t: Target, data: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, t.width, t.height, gl.RGBA, gl.FLOAT, data);
  }

  /** 계산 패스를 시작하기 전에 한 번 부른다. 그리기용 상태를 계산용으로 바꾼다. */
  begin(): void {
    const gl = this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
  }

  run(frag: string, out: Target, values: Record<string, UniformValue>): void {
    const gl = this.gl;
    const p = this.program(frag);
    gl.useProgram(p.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
    gl.viewport(0, 0, out.width, out.height);
    let unit = 0;
    for (const [name, u] of p.uniforms) {
      const v = values[name];
      if (v === undefined) throw new Error(`유니폼 ${name} 값이 없다`);
      if (u.type === gl.SAMPLER_2D) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, v as WebGLTexture);
        gl.uniform1i(u.loc, unit++);
      } else if (u.type === gl.INT) gl.uniform1i(u.loc, v as number);
      else if (u.type === gl.INT_VEC2) gl.uniform2i(u.loc, (v as number[])[0], (v as number[])[1]);
      else if (u.type === gl.FLOAT) gl.uniform1f(u.loc, v as number);
      else if (u.type === gl.FLOAT_VEC2) gl.uniform2f(u.loc, (v as number[])[0], (v as number[])[1]);
      else if (u.type === gl.FLOAT_VEC3) gl.uniform3f(u.loc, (v as number[])[0], (v as number[])[1], (v as number[])[2]);
      else throw new Error(`유니폼 ${name}의 형식을 다루지 못한다`);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** 계산 패스를 마친 뒤 부른다. 화면용 프레임버퍼로 되돌린다. */
  end(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.activeTexture(gl.TEXTURE0);
  }

  read(t: Target, x = 0, y = 0, w = t.width, h = t.height): Float32Array {
    const gl = this.gl;
    const out = new Float32Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, out);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  dispose(targets: Target[], textures: WebGLTexture[] = []): void {
    for (const t of targets) { this.gl.deleteFramebuffer(t.fbo); this.gl.deleteTexture(t.tex); }
    for (const t of textures) this.gl.deleteTexture(t);
  }
}

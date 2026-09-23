import * as THREE from 'three';
import { FULLSCREEN_VERT } from './shaders';

/** 전체 화면 삼각형 하나로 프래그먼트 셰이더를 돌리는 최소한의 GPGPU 도우미. */
export class GpuCompute {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;

  constructor(readonly renderer: THREE.WebGLRenderer) {
    const gl = renderer.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) throw new Error('WebGL2가 필요합니다.');
    if (!gl.getExtension('EXT_color_buffer_float')) {
      throw new Error('이 기기는 부동소수점 렌더 타깃(EXT_color_buffer_float)을 지원하지 않아 시뮬레이션을 돌릴 수 없습니다.');
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.mesh = new THREE.Mesh(geo);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  material(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.RawShaderMaterial {
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERT,
      fragmentShader,
      uniforms,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  target(nx: number, ny: number): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(nx, ny, {
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    });
  }

  dataTexture(data: Float32Array, nx: number, ny: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, nx, ny, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = THREE.NearestFilter;
    t.magFilter = THREE.NearestFilter;
    t.colorSpace = THREE.NoColorSpace;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  run(material: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget): void {
    const prev = this.renderer.getRenderTarget();
    this.mesh.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }
}

export const COPY_FRAG = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }
`;

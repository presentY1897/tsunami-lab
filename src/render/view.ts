import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { childRectInParent, type GridSpec } from '../geo/grid';
import { cosLatAtPy, DEG, EARTH_CIRCUMFERENCE, latToPy, lonToPx } from '../geo/mercator';
import type { GpuSolver } from '../gpu/solver';
import { makeGridGeometry, makeTerrainMaterial, OVERLAY_INDEX, type OverlayMode } from './terrain';
import { makeWaterMaterial } from './water';

interface LevelMeshes {
  terrain: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  water: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

export interface ViewOptions {
  /** 메시 한 변의 최대 분할 수. */
  maxSegments: number;
}

/**
 * 3차원 장면. 모든 단계의 지형과 수면을 한 좌표계에 놓는다.
 * 좌표: X = 동, Z = 남, Y = 위. 단위는 km이고 관측 해안의 위도에서 실제 거리와 같다.
 * 지형과 수면 메시는 시뮬레이션이 쓰는 것과 같은 텍스처를 같은 방식으로 보간한다.
 * 그래서 물이 지형과 만나는 선이 계산된 젖음 경계와 일치한다.
 */
export class SceneView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: MapControls;
  readonly shared: Record<string, THREE.IUniform>;
  private meshes: LevelMeshes[] = [];
  private solver: GpuSolver | null = null;
  private refLat = 0;
  private originPx = 0; // 줌 0 기준 전역 픽셀
  private originPy = 0;
  private kmPerPx0 = 1;
  private markers = new THREE.Group();
  private l0WidthKm = 1000;
  private sourceAmp = 1;
  /** 사용자가 고른 배율. 자동 과장에 곱한다. */
  exagUser = 1;
  boostUser = 1;
  tintOn = true;
  private fly: { t: number; dur: number; p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3 } | null = null;

  constructor(readonly renderer: THREE.WebGLRenderer, readonly opt: ViewOptions = { maxSegments: 1024 }) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 20000);
    this.controls = new MapControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.maxPolarAngle = 86 * DEG;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = false;
    this.scene.background = new THREE.Color(0.80, 0.87, 0.93);
    this.scene.add(this.markers);
    const sun = new THREE.Vector3(-0.55, 0.62, -0.56).normalize();
    this.shared = {
      uExag: { value: 3 },
      uWaveBoost: { value: 1 },
      uClock: { value: 0 },
      uTintScale: { value: 0 },
      uFogDensity: { value: 0.0002 },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: sun },
      uOverlay: { value: 0 },
      uTimeNow: { value: 0 },
      uArrivalSpan: { value: 3600 },
    };
  }

  /** 경위도를 장면 좌표(km)로. */
  toScene(lon: number, lat: number, heightKm = 0): THREE.Vector3 {
    let px = lonToPx(lon, 0);
    // 날짜변경선을 넘는 영역에서는 원점과 같은 쪽으로 편다
    if (px - this.originPx > 128) px -= 256;
    else if (this.originPx - px > 128) px += 256;
    return new THREE.Vector3((px - this.originPx) * this.kmPerPx0, heightKm, (latToPy(lat, 0) - this.originPy) * this.kmPerPx0);
  }

  private levelCenter(g: GridSpec): THREE.Vector3 {
    const s = 2 ** g.z;
    const cx = (g.px0 + g.nx / 2) / s, cy = (g.py0 + g.ny / 2) / s;
    return new THREE.Vector3((cx - this.originPx) * this.kmPerPx0, 0, (cy - this.originPy) * this.kmPerPx0);
  }

  setSolver(solver: GpuSolver, refLat: number, sourceAmp: number): void {
    this.clear();
    this.solver = solver;
    this.refLat = refLat;
    this.sourceAmp = Math.max(0.3, sourceAmp);
    const g0 = solver.levels[0].input.grid;
    const s0 = 2 ** g0.z;
    this.originPx = (g0.px0 + g0.nx / 2) / s0;
    this.originPy = (g0.py0 + g0.ny / 2) / s0;
    this.kmPerPx0 = ((EARTH_CIRCUMFERENCE / 256) * Math.cos(refLat * DEG)) / 1000;

    solver.levels.forEach((lv, i) => {
      const g = lv.input.grid;
      const s = 2 ** g.z;
      const extent: [number, number] = [(g.nx / s) * this.kmPerPx0, (g.ny / s) * this.kmPerPx0];
      if (i === 0) this.l0WidthKm = Math.max(extent[0], extent[1]);
      const cellM = (EARTH_CIRCUMFERENCE / (256 * s)) * cosLatAtPy(g.py0 + g.ny / 2, g.z);
      const segX = Math.min(g.nx, this.opt.maxSegments), segY = Math.min(g.ny, this.opt.maxSegments);
      const geo = makeGridGeometry(segX, segY);
      // 음영 세기는 수직 과장에 비례한다. 단계와 무관하게 같은 값을 쓴다.
      const shadeExag = 0.5;
      const terrain = new THREE.Mesh(geo, makeTerrainMaterial({ staticTex: lv.staticTex, nx: g.nx, ny: g.ny, extentKm: extent, cellM, shadeExag }, this.shared));
      const water = new THREE.Mesh(geo, makeWaterMaterial({ staticTex: lv.staticTex, nx: g.nx, ny: g.ny, extentKm: extent, cellM, rippleScale: cellM > 1000 ? 3 : cellM > 150 ? 5 : 9 }, this.shared));
      const c = this.levelCenter(g);
      terrain.position.copy(c);
      water.position.copy(c);
      terrain.frustumCulled = false;
      water.frustumCulled = false;
      terrain.renderOrder = i;
      water.renderOrder = 100 + i;
      const child = solver.levels[i + 1];
      if (child) {
        const [i0, j0, i1, j1] = childRectInParent(g, child.input.grid);
        for (const m of [terrain.material, water.material]) {
          (m.uniforms.uChildRect.value as THREE.Vector4).set(i0, j0, i1, j1);
          m.uniforms.uHasChild.value = 1;
        }
      }
      this.scene.add(terrain, water);
      this.meshes.push({ terrain, water });
    });
  }

  setOverlay(mode: OverlayMode): void {
    this.shared.uOverlay.value = OVERLAY_INDEX[mode];
  }

  setDrape(levelIndex: number, tex: THREE.Texture | null, mix = 0.85): void {
    const m = this.meshes[levelIndex]?.terrain.material;
    if (!m) return;
    m.uniforms.uDrape.value = tex;
    m.uniforms.uDrapeMix.value = tex ? mix : 0;
  }

  /** 지도 위에 선을 그린다. 발생원 윤곽과 관측 영역 표시에 쓴다. */
  addOutline(points: [number, number][], color: number, closed = true): void {
    const pts = points.map(([lon, lat]) => this.toScene(lon, lat, 0));
    if (closed) pts.push(pts[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
    line.renderOrder = 500;
    this.markers.add(line);
  }

  addLevelOutline(g: GridSpec, color: number): void {
    const s = 2 ** g.z;
    const x0 = (g.px0 / s - this.originPx) * this.kmPerPx0, x1 = ((g.px0 + g.nx) / s - this.originPx) * this.kmPerPx0;
    const z0 = (g.py0 / s - this.originPy) * this.kmPerPx0, z1 = ((g.py0 + g.ny) / s - this.originPy) * this.kmPerPx0;
    const pts = [new THREE.Vector3(x0, 0, z0), new THREE.Vector3(x1, 0, z0), new THREE.Vector3(x1, 0, z1), new THREE.Vector3(x0, 0, z1), new THREE.Vector3(x0, 0, z0)];
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 }));
    line.renderOrder = 500;
    this.markers.add(line);
  }

  /** 카메라를 목표 지점으로 부드럽게 옮긴다. distKm은 목표까지 거리, pitchDeg는 내려다보는 각, bearing은 카메라가 보는 방위. */
  flyTo(lon: number, lat: number, distKm: number, pitchDeg: number, bearingDeg: number, duration = 1.6): void {
    const target = this.toScene(lon, lat, 0);
    const pitch = pitchDeg * DEG, b = bearingDeg * DEG;
    // 방위 b를 바라보려면 카메라는 목표의 반대쪽에 있어야 한다. 북 = -Z, 동 = +X.
    const back = new THREE.Vector3(-Math.sin(b), 0, Math.cos(b));
    const pos = target.clone().addScaledVector(back, distKm * Math.cos(pitch)).add(new THREE.Vector3(0, distKm * Math.sin(pitch), 0));
    if (duration <= 0) {
      this.camera.position.copy(pos);
      this.controls.target.copy(target);
      this.fly = null;
      return;
    }
    this.fly = { t: 0, dur: duration, p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: target };
  }

  viewOcean(duration = 1.6): void {
    if (!this.solver) return;
    const g = this.solver.levels[0].input.grid;
    const s = 2 ** g.z;
    const c = new THREE.Vector3(0, 0, 0);
    const dist = this.l0WidthKm * 1.15;
    const pos = c.clone().add(new THREE.Vector3(0, dist * Math.sin(62 * DEG), dist * Math.cos(62 * DEG)));
    void s;
    if (duration <= 0) {
      this.camera.position.copy(pos);
      this.controls.target.copy(c);
      return;
    }
    this.fly = { t: 0, dur: duration, p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: c };
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  /** 카메라 거리에 따라 수직 과장과 파고 과장을 자동으로 정한다. 가까이서는 실제 비율에 가깝게, 멀리서는 기복이 보이게. */
  private updateExaggeration(): void {
    const d = this.camera.position.distanceTo(this.controls.target);
    const f = THREE.MathUtils.smoothstep(Math.log(d), Math.log(25), Math.log(1500));
    const exag = THREE.MathUtils.lerp(2.5, 22, f) * this.exagUser;
    this.shared.uExag.value = exag;
    // 멀리서 본 파고가 장면 폭의 약 1.5%로 보이게 하는 배율
    const maxBoost = THREE.MathUtils.clamp((0.015 * this.l0WidthKm * 1000) / (22 * this.sourceAmp), 1, 4000);
    const fb = THREE.MathUtils.smoothstep(Math.log(d), Math.log(60), Math.log(900));
    this.shared.uWaveBoost.value = 1 + (maxBoost - 1) * fb * this.boostUser;
    this.shared.uTintScale.value = this.tintOn ? this.sourceAmp * THREE.MathUtils.lerp(1.5, 0.35, fb) * (fb > 0.02 ? 1 : 0) : 0;
    this.shared.uFogDensity.value = 0.55 / Math.max(d * 6, 40);
    this.camera.near = Math.max(0.005, d * 0.01);
    this.camera.far = d * 60 + this.l0WidthKm * 3;
    this.camera.updateProjectionMatrix();
  }

  render(dtWall: number, simTime: number): void {
    if (this.fly) {
      const f = this.fly;
      f.t = Math.min(1, f.t + dtWall / f.dur);
      const e = f.t * f.t * (3 - 2 * f.t);
      this.camera.position.lerpVectors(f.p0, f.p1, e);
      this.controls.target.lerpVectors(f.t0, f.t1, e);
      if (f.t >= 1) this.fly = null;
    }
    this.controls.update();
    this.updateExaggeration();
    (this.shared.uCamPos.value as THREE.Vector3).copy(this.camera.position);
    this.shared.uClock.value = (this.shared.uClock.value as number) + dtWall;
    this.shared.uTimeNow.value = simTime;
    if (this.solver) {
      this.solver.levels.forEach((lv, i) => {
        const m = this.meshes[i];
        m.water.material.uniforms.uEta.value = lv.renderEta.texture;
        m.water.material.uniforms.uRecord.value = lv.recCur.texture;
        m.terrain.material.uniforms.uRecord.value = lv.recCur.texture;
      });
    }
    this.renderer.render(this.scene, this.camera);
  }

  clear(): void {
    for (const m of this.meshes) {
      this.scene.remove(m.terrain, m.water);
      m.terrain.geometry.dispose();
      m.terrain.material.dispose();
      m.water.material.dispose();
    }
    this.meshes = [];
    for (const c of [...this.markers.children]) {
      this.markers.remove(c);
      const l = c as THREE.Line;
      l.geometry.dispose();
      (l.material as THREE.Material).dispose();
    }
    this.solver = null;
  }

  get referenceLatitude(): number {
    return this.refLat;
  }
}

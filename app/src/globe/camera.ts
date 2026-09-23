import { dirToLonLat, lonLatToDir } from './icosphere';
import { basis, dot, multiply, perspective, transformPoint, viewMatrix, type Basis, type Mat4, type Vec3 } from './mat4';

const DEG = Math.PI / 180;
const FOV = 35 * DEG;
const EARTH_RADIUS_KM = 6371;
/** 가까이 갈수록 시점을 눕힌다. 바로 위에서 내려다보면 지형의 높낮이가 보이지 않는다. 사용자가 여기에 더 기울이거나 세울 수 있다. */
const MAX_TILT = 55 * DEG;
const TILT_LIMIT = 78 * DEG;
/** 손가락과 마우스 드래그 1 px당 기울기와 방향의 변화(라디안). */
const TILT_PER_PX = 0.25 * DEG;
const HEADING_PER_PX = 0.3 * DEG;
const TILT_START_KM = 3000;
const TILT_FULL_KM = 120;

/**
 * 지구를 도는 카메라. 보는 지점의 경위도와, 그 지점까지의 거리(지구 반지름 단위)로 상태를 둔다. 북쪽이 항상 화면 위다.
 * 멀리서는 바로 위에서 내려다보고, 가까이 가면 남쪽에서 비스듬히 본다.
 * 손가락 하나로 돌리고, 두 손가락이나 휠로 확대한다. 손을 떼면 관성으로 조금 더 돈다.
 */
export class GlobeCamera {
  lon = 135;
  lat = 28;
  alt = 3;
  private vLon = 0;
  private vLat = 0;
  private altTarget = 3;
  width = 1;
  height = 1;
  /** 가장 가까이 갔을 때 화면의 좁은 쪽에 보이는 폭(km). 가장 작은 삼각형의 크기에 맞춰 밖에서 정한다. */
  minViewKm = 800;
  tilt = 0;
  /** 사용자가 자동 기울기에 더한 값(라디안). */
  tiltOffset = 0;
  /** 화면 위쪽이 가리키는 방위(라디안, 북쪽 0, 시계 방향). */
  heading = 0;
  eye: Vec3 = [0, 0, 1];
  /** 보는 지점의 단위 벡터. */
  target: Vec3 = [0, 0, 1];
  basis!: Basis;
  /** 절대 좌표 기준 행렬. 화면 좌표 계산과 메시를 나눌지 판단하는 데 쓴다. */
  viewProj!: Mat4;
  private proj!: Mat4;
  /** 사용자가 한 번이라도 만졌는지. 만지기 전에는 천천히 자전시킨다. */
  touched = false;
  onTap: ((lon: number, lat: number) => void) | null = null;
  onChange: (() => void) | null = null;

  private readonly pointers = new Map<number, { x: number; y: number }>();
  private down: { x: number; y: number; t: number } | null = null;
  private moved = false;
  private pinch: { dist: number; alt: number; angle: number; midY: number } | null = null;
  /** 오른쪽 버튼이나 Ctrl 드래그로 기울기와 방향을 바꾸는 중. */
  private orbiting = false;

  constructor(private readonly el: HTMLElement) {
    el.addEventListener('pointerdown', (e) => this.pointerDown(e));
    el.addEventListener('pointermove', (e) => this.pointerMove(e));
    el.addEventListener('pointerup', (e) => this.pointerUp(e, true));
    el.addEventListener('pointercancel', (e) => this.pointerUp(e, false));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.touched = true;
      this.setAltTarget(this.altTarget * Math.exp(e.deltaY * 0.0012));
    }, { passive: false });
    this.update();
  }

  private get tanNarrow(): number {
    return Math.tan(FOV / 2) * Math.min(1, this.width / this.height);
  }
  /** 지구 전체가 좁은 쪽의 86%를 채우는 고도. */
  get altFit(): number {
    return 1 / Math.sin(Math.atan(this.tanNarrow) * 0.86) - 1;
  }
  get altMin(): number {
    return this.minViewKm / EARTH_RADIUS_KM / (2 * this.tanNarrow);
  }
  /** 시야각의 절반(라디안). */
  get halfFovY(): number {
    return FOV / 2;
  }
  get halfFovX(): number {
    return Math.atan(Math.tan(FOV / 2) * (this.width / this.height));
  }
  /** 거리 1에서 1 라디안이 화면에서 차지하는 px. */
  get pxPerRad(): number {
    return this.height / (2 * Math.tan(FOV / 2));
  }
  get altMax(): number {
    return this.altFit * 1.35;
  }

  resize(w: number, h: number): void {
    const first = this.width === 1 && this.height === 1;
    this.width = Math.max(1, w);
    this.height = Math.max(1, h);
    if (first) { this.alt = this.altTarget = this.altFit; }
    this.setAltTarget(this.altTarget);
    this.update();
  }

  private setAltTarget(a: number): void {
    this.altTarget = Math.max(this.altMin, Math.min(this.altMax, a));
    this.onChange?.();
  }

  /** 화면 가운데에서 1 CSS px이 지표에서 차지하는 각(라디안). */
  get radPerPx(): number {
    return (this.alt * 2 * Math.tan(FOV / 2)) / this.height;
  }

  /** 화면 가운데 가로로 보이는 거리(km). */
  get viewWidthKm(): number {
    return Math.min(2, this.radPerPx * this.width) * EARTH_RADIUS_KM;
  }

  /** 보이는 폭이 km가 되도록 부드럽게 물러나거나 다가간다. */
  zoomToView(km: number): void {
    this.touched = true;
    this.setAltTarget((this.alt * km) / this.viewWidthKm);
  }

  jumpTo(lon: number, lat: number, alt?: number): void {
    this.lon = lon; this.lat = lat;
    if (alt !== undefined) { this.alt = this.altTarget = Math.max(this.altMin, Math.min(this.altMax, alt)); }
    this.vLon = this.vLat = 0;
    this.touched = true;
    this.update();
    this.onChange?.();
  }

  /** 한 프레임 진행. 아직 움직이는 중이면 true. */
  tick(dt: number): boolean {
    let active = false;
    if (!this.touched) { this.lon += 2.2 * dt; active = true; }
    if (this.pointers.size === 0 && (Math.abs(this.vLon) > 0.02 || Math.abs(this.vLat) > 0.02)) {
      this.lon += this.vLon * dt; this.lat += this.vLat * dt;
      const k = Math.exp(-dt * 4.5);
      this.vLon *= k; this.vLat *= k;
      active = true;
    }
    if (Math.abs(this.altTarget - this.alt) > this.alt * 0.001) {
      this.alt += (this.altTarget - this.alt) * Math.min(1, dt * 12);
      active = true;
    }
    if (active) this.update();
    return active;
  }

  private update(): void {
    this.lat = Math.max(-85, Math.min(85, this.lat));
    this.lon = ((((this.lon + 180) % 360) + 360) % 360) - 180;
    const t = lonLatToDir(this.lon, this.lat);
    const la = this.lat * DEG, lo = this.lon * DEG;
    const north: Vec3 = [-Math.sin(la) * Math.sin(lo), Math.cos(la), -Math.sin(la) * Math.cos(lo)];
    const east: Vec3 = [Math.cos(lo), 0, -Math.sin(lo)];
    const k = Math.max(0, Math.min(1, (Math.log(this.viewWidthKm) - Math.log(TILT_FULL_KM)) / (Math.log(TILT_START_KM) - Math.log(TILT_FULL_KM))));
    const autoTilt = MAX_TILT * (1 - k * k * (3 - 2 * k));
    this.tilt = Math.max(0, Math.min(TILT_LIMIT, autoTilt + this.tiltOffset));
    // 화면 위쪽이 가리키는 방향. 방위 0이면 북쪽이다.
    const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
    const up: Vec3 = [north[0] * ch + east[0] * sh, north[1] * ch + east[1] * sh, north[2] * ch + east[2] * sh];
    const c = Math.cos(this.tilt) * this.alt, sn = Math.sin(this.tilt) * this.alt;
    this.target = t;
    this.eye = [t[0] * (1 + c) - up[0] * sn, t[1] * (1 + c) - up[1] * sn, t[2] * (1 + c) - up[2] * sn];
    this.basis = basis(this.eye, t, up);
    const elen = Math.hypot(this.eye[0], this.eye[1], this.eye[2]);
    // 먼 쪽은 지평선까지만 잡는다. 가까이 갔을 때 깊이 버퍼의 정밀도를 아끼기 위해서다.
    const horizon = Math.sqrt(Math.max(0, elen * elen - 1));
    const far = Math.min(elen + 1.2, horizon * 1.2 + 0.05);
    this.proj = perspective(FOV, this.width / this.height, this.alt * 0.2, far);
    this.viewProj = multiply(this.proj, viewMatrix(this.eye, this.basis));
  }

  /** origin을 원점으로 한 상대 좌표용 행렬. 눈의 위치를 배정밀도로 빼고 나서 float32로 넘기므로 가까이서도 떨리지 않는다. */
  viewProjRelative(origin: Vec3): { matrix: Mat4; eye: Vec3 } {
    const eye: Vec3 = [this.eye[0] - origin[0], this.eye[1] - origin[1], this.eye[2] - origin[2]];
    return { matrix: multiply(this.proj, viewMatrix(eye, this.basis)), eye };
  }

  /** 화면 좌표(CSS px)가 가리키는 지표의 경위도. 지구 밖이면 null. */
  pick(x: number, y: number): [number, number] | null {
    const t = Math.tan(FOV / 2);
    const nx = ((x / this.width) * 2 - 1) * t * (this.width / this.height);
    const ny = (1 - (y / this.height) * 2) * t;
    const { right: r, up: u, forward: f } = this.basis;
    const dir: Vec3 = [f[0] + r[0] * nx + u[0] * ny, f[1] + r[1] * nx + u[1] * ny, f[2] + r[2] * nx + u[2] * ny];
    const l = Math.hypot(dir[0], dir[1], dir[2]);
    dir[0] /= l; dir[1] /= l; dir[2] /= l;
    const b = dot(this.eye, dir), c = dot(this.eye, this.eye) - 1;
    const disc = b * b - c;
    if (disc < 0) return null;
    const s = -b - Math.sqrt(disc);
    if (s < 0) return null;
    return dirToLonLat(this.eye[0] + dir[0] * s, this.eye[1] + dir[1] * s, this.eye[2] + dir[2] * s);
  }

  /** 경위도를 화면 좌표(CSS px)로. 지구 뒤편이면 null. */
  project(lon: number, lat: number): [number, number] | null {
    const p = lonLatToDir(lon, lat);
    if (dot(p, this.eye) < 1) return null; // 지평선 너머
    const c = transformPoint(this.viewProj, p);
    if (c[3] <= 0) return null;
    return [((c[0] / c[3]) * 0.5 + 0.5) * this.width, (0.5 - (c[1] / c[3]) * 0.5) * this.height];
  }

  /** 기울기와 방향을 사용자가 바꿨는가. */
  get adjusted(): boolean {
    return Math.abs(this.tiltOffset) > 0.001 || Math.abs(this.heading) > 0.001;
  }

  /** 기울기와 방향을 자동값(북쪽 위)으로 되돌린다. */
  resetView(): void {
    this.tiltOffset = 0;
    this.heading = 0;
    this.update();
    this.onChange?.();
  }

  private adjustView(dTilt: number, dHeading: number): void {
    this.touched = true;
    const autoTilt = this.tilt - this.tiltOffset;
    this.tiltOffset = Math.max(-autoTilt, Math.min(TILT_LIMIT - autoTilt, this.tiltOffset + dTilt));
    this.heading = ((this.heading + dHeading + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    this.update();
  }

  private pointerDown(e: PointerEvent): void {
    this.el.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    this.vLon = this.vLat = 0;
    if (this.pointers.size === 1) {
      this.down = { x: e.offsetX, y: e.offsetY, t: performance.now() };
      this.moved = false;
      // 오른쪽 버튼이나 Ctrl을 누른 드래그는 기울기와 방향을 바꾼다(데스크톱)
      this.orbiting = e.pointerType === 'mouse' && (e.button === 2 || e.ctrlKey);
    }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), alt: this.altTarget, angle: Math.atan2(b.y - a.y, b.x - a.x), midY: (a.y + b.y) / 2 };
      this.moved = true;
      this.orbiting = false;
    }
    this.onChange?.();
  }

  private pointerMove(e: PointerEvent): void {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.offsetX - p.x, dy = e.offsetY - p.y;
    p.x = e.offsetX; p.y = e.offsetY;
    if (this.pointers.size === 1 && this.down) {
      if (Math.hypot(e.offsetX - this.down.x, e.offsetY - this.down.y) > 7) this.moved = true;
      if (!this.moved) return;
      if (this.orbiting) { this.adjustView(-dy * TILT_PER_PX, dx * HEADING_PER_PX); this.onChange?.(); return; }
      this.touched = true;
      const k = this.radPerPx / DEG;
      // 화면 오른쪽과 위쪽이 지표에서 가리키는 방향은 방위에 따라 돈다. 기울여 볼 때는 세로 움직임이 지표에서 더 멀리 간다.
      const r = dx * k, u = (-dy * k) / Math.max(0.35, Math.cos(this.tilt));
      const ch = Math.cos(this.heading), sh = Math.sin(this.heading);
      const dE = -(r * ch + u * sh), dN = -(-r * sh + u * ch);
      const dLon = dE / Math.max(0.2, Math.cos(this.lat * DEG)), dLat = dN;
      this.lon += dLon; this.lat += dLat;
      // 관성용 속도(도/초). 최근 움직임을 부드럽게 따라간다.
      this.vLon = this.vLon * 0.6 + dLon * 60 * 0.4;
      this.vLat = this.vLat * 0.6 + dLat * 60 * 0.4;
      this.update();
    } else if (this.pointers.size === 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.touched = true;
      this.setAltTarget((this.pinch.alt * this.pinch.dist) / Math.max(10, d));
      // 두 손가락을 같이 위아래로 끌면 기울이고, 돌리면 방향이 돈다
      const angle = Math.atan2(b.y - a.y, b.x - a.x), midY = (a.y + b.y) / 2;
      let dA = angle - this.pinch.angle;
      dA = ((dA + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      this.adjustView(-(midY - this.pinch.midY) * TILT_PER_PX, -dA);
      this.pinch.angle = angle;
      this.pinch.midY = midY;
    }
    this.onChange?.();
  }

  private pointerUp(e: PointerEvent, allowTap: boolean): void {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      const wasOrbit = this.orbiting;
      this.orbiting = false;
      if (allowTap && !wasOrbit && this.down && !this.moved && performance.now() - this.down.t < 500) {
        const hit = this.pick(e.offsetX, e.offsetY);
        this.touched = true;
        if (hit) this.onTap?.(hit[0], hit[1]);
      }
      this.down = null;
    }
    this.onChange?.();
  }
}

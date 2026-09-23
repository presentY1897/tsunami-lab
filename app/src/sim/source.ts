import type { ImpactParams } from '../../../src/physics/impact';
import { buildQuakeField, type QuakeParams } from '../../../src/physics/quake';
import { buildImpactModel, type ImpactModel } from './impact';

export type SourceParams = QuakeParams | ImpactParams;

/** 한 단계의 격자에 올릴 초기 변위장. */
export interface SourceField {
  reachKm: number;
  /** 초기 수면 변위(m). */
  uz(lon: number, lat: number): number;
  /** 지반도 같이 움직이는가(지진은 그렇다, 소행성은 아니다). */
  movesBed: boolean;
}

/**
 * 발생원 모형. 격자 셀 크기에 맞는 변위장을 준다.
 * 지진은 어느 셀 크기든 같은 Okada 변위장이다. 소행성은 셀 크기마다 공동을 따로 만들고 보정한다.
 */
export interface SourceModel {
  params: SourceParams;
  fieldFor(cellM: number): SourceField;
  /** 색과 과장의 기준 진폭(m). */
  refAmp: number;
  /** 원거리 감쇠 보정의 기준 거리(m). 0이면 보정 없음. */
  gainRef: number;
  impact: ImpactModel | null;
  /** 지진의 단층 윤곽. */
  outline: [number, number][] | null;
  maxUpHint: number;
}

export function buildSourceModel(p: SourceParams, waterDepthAtSource: number, gainRef: number): SourceModel | null {
  if (p.kind === 'quake') {
    const q = buildQuakeField(p);
    return {
      params: p,
      fieldFor: () => ({ reachKm: q.reachKm, uz: (lon, lat) => q.uz(lon, lat), movesBed: true }),
      refAmp: 1, gainRef: 0, impact: null, outline: q.outline, maxUpHint: 0,
    };
  }
  const m = buildImpactModel(p, waterDepthAtSource, gainRef);
  if (!m) return null;
  return {
    params: p,
    fieldFor: (cellM) => { const c = m.cavityFor(cellM); return { reachKm: c.reachKm, uz: (lon, lat) => c.eta0(lon, lat), movesBed: false }; },
    refAmp: Math.max(1, m.targetAmp), gainRef, impact: m, outline: null, maxUpHint: 0,
  };
}

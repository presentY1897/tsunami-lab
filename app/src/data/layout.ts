// 빌드 결과물에 들어가는 표고 자료의 배치. 빌드 스크립트와 앱이 같이 쓴다. 다른 모듈을 import하지 않는다.

/** 전 지구 한 장짜리 자료. 약 39 km/px. 첫 화면에서 받는다. */
export const GLOBAL_ZOOM = 2;
export const GLOBAL_FILE = 'data/earth-z2.bin';

/** 조각 자료. 약 10 km/px. 256×256 셀짜리 조각으로 나눠 두고 필요한 것만 받는다. */
export const CHUNK_ZOOM = 4;
export const CHUNK_SIZE = 256;
/** 조각 행의 범위. 위도 약 ±74도다. 그 바깥은 전 지구 자료로 그린다. */
export const CHUNK_ROW_MIN = 3;
export const CHUNK_ROW_MAX = 12;
export const CHUNK_COLS = 2 ** CHUNK_ZOOM;

export const chunkFile = (x: number, y: number): string => `data/z${CHUNK_ZOOM}/${x}_${y}.bin`;
export const chunkExists = (y: number): boolean => y >= CHUNK_ROW_MIN && y <= CHUNK_ROW_MAX;

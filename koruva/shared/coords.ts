import { CHUNK_SIZE } from "./constants";

export function chunkCoord(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}
export function localCoord(v: number): number {
  return ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}
/** チャンク内インデックス: (y * 16 + lz) * 16 + lx */
export function localIndex(x: number, y: number, z: number): number {
  return (y * CHUNK_SIZE + localCoord(z)) * CHUNK_SIZE + localCoord(x);
}

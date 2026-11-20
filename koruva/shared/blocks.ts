export type RenderKind = "opaque" | "cutout" | "liquid";

export interface BlockDef {
  id: number;
  key: string;
  name: string;
  solid: boolean;
  render: RenderKind;
  /** 同じブロック同士の接触面を描画しない */
  cullSame: boolean;
  emissive: boolean;
  tiles: { top: string; side: string; bottom: string };
}

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAVES: 6, PLANKS: 7,
  GLASS: 8, COBBLE: 9, BRICK: 10, SNOW: 11, WATER: 12, LAMP: 13, BEDROCK: 14,
  GRAVEL: 15, ORE: 16, RED: 17, BLUE: 18, YELLOW: 19, WHITE: 20,
} as const;

function def(
  id: number, key: string, name: string,
  top: string, side = top, bottom = top,
  o: Partial<Pick<BlockDef, "solid" | "render" | "cullSame" | "emissive">> = {},
): BlockDef {
  return {
    id, key, name,
    solid: o.solid ?? true,
    render: o.render ?? "opaque",
    cullSame: o.cullSame ?? true,
    emissive: o.emissive ?? false,
    tiles: { top, side, bottom },
  };
}

export const BLOCKS: BlockDef[] = [
  def(0, "air", "空気", "none", "none", "none", { solid: false, render: "cutout" }),
  def(1, "grass", "草ブロック", "grass_top", "grass_side", "dirt"),
  def(2, "dirt", "土", "dirt"),
  def(3, "stone", "石", "stone"),
  def(4, "sand", "砂", "sand"),
  def(5, "log", "原木", "log_top", "log_side", "log_top"),
  def(6, "leaves", "葉", "leaves", "leaves", "leaves", { render: "cutout", cullSame: false }),
  def(7, "planks", "板材", "planks"),
  def(8, "glass", "ガラス", "glass", "glass", "glass", { render: "cutout" }),
  def(9, "cobble", "丸石", "cobble"),
  def(10, "brick", "レンガ", "brick"),
  def(11, "snow", "雪", "snow"),
  def(12, "water", "水", "water", "water", "water", { solid: false, render: "liquid" }),
  def(13, "lamp", "ランプ", "lamp", "lamp", "lamp", { emissive: true }),
  def(14, "bedrock", "岩盤", "bedrock"),
  def(15, "gravel", "砂利", "gravel"),
  def(16, "ore", "鉱石", "ore"),
  def(17, "red", "赤ブロック", "red"),
  def(18, "blue", "青ブロック", "blue"),
  def(19, "yellow", "黄ブロック", "yellow"),
  def(20, "white", "白ブロック", "white"),
];

export const BLOCK_COUNT = BLOCKS.length - 1; // 有効ID: 1..BLOCK_COUNT

/** 設置可能(インベントリに並ぶ)ブロック */
export const PLACEABLE: number[] = BLOCKS.filter((b) => b.id !== 0 && b.id !== B.BEDROCK && b.id !== B.WATER).map((b) => b.id);

export const TILE_KEYS: string[] = Array.from(
  new Set(BLOCKS.slice(1).flatMap((b) => [b.tiles.top, b.tiles.side, b.tiles.bottom])),
);

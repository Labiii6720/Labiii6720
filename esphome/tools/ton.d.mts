// Typen für esphome/tools/ton.mjs (der Test importiert das Skript direkt).
export declare const RATE: number;
export declare const MAX_BYTES: number;
export interface TonTeil { hz?: number; ms: number }
export declare const TOENE: Record<"wake" | "fehler", TonTeil[]>;
export declare function pcm(folge: TonTeil[], optionen?: { pegel?: number; rampeMs?: number }): Int16Array;
export declare function alsBytes(samples: Int16Array): Uint8Array;
export declare function tonBytes(art: "wake" | "fehler"): Uint8Array;
export declare function paketYaml(): string;

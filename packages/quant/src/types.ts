/** Candle with epoch-seconds bar OPEN time (UTC). */
export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number }
export type Interval = 1 | 5 | 15 | 25 | 60 | "D";
export const IST_OFFSET_S = 19800;
/** IST calendar day key for a bar. */
export const istDay = (t: number) => Math.floor((t + IST_OFFSET_S) / 86400);
/** IST minutes since midnight. */
export const istMinutes = (t: number) => Math.floor(((t + IST_OFFSET_S) % 86400) / 60);
export const fmtIstHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

import { HistoryRound, LiveBetRow } from '../types/crash';

export const PRESET_STAKES = [10, 50, 100, 400, 1000, 5000] as const;

export const INITIAL_SIMULATED_PLAYERS: Array<{
  username: string;
  stake: number;
  target: number;
}> = [
  { username: '17*******', stake: 1848.7, target: 1.54 },
  { username: '75*******', stake: 1506.07, target: 1.52 },
  { username: '35*******', stake: 1389.69, target: 4.15 },
  { username: '97*******', stake: 1388.5, target: 1.24 },
  { username: '83*******', stake: 1357.77, target: 1.27 },
  { username: '15*******', stake: 1338.31, target: 3.85 },
  { username: '86*******', stake: 1283.07, target: 1.76 },
  { username: '10*******', stake: 1246.56, target: 1.68 },
  { username: '76*******', stake: 1212.73, target: 5.10 },
  { username: '65*******', stake: 1137.63, target: 1.90 },
  { username: '80*******', stake: 1105.06, target: 1.94 },
  { username: '37*******', stake: 894.71, target: 6.40 },
  { username: '93*******', stake: 833.73, target: 3.45 },
  { username: '04*******', stake: 797.1, target: 4.90 },
  { username: '89*******', stake: 769.72, target: 1.77 },
  { username: '77*******', stake: 738.59, target: 7.20 },
  { username: '50*******', stake: 683.48, target: 3.60 },
  { username: '49*******', stake: 637.41, target: 1.48 },
  { username: '96*******', stake: 553.54, target: 1.12 },
  { username: '15*******', stake: 545.67, target: 2.95 },
  { username: '71*******', stake: 407.03, target: 1.96 },
  { username: '88*******', stake: 397.16, target: 2.78 },
  { username: '53*******', stake: 272.21, target: 4.50 },
  { username: '80*******', stake: 196.47, target: 5.80 },
  { username: '48*******', stake: 180.5, target: 1.10 },
  { username: '85*******', stake: 170.14, target: 3.30 },
  { username: '49*******', stake: 126.72, target: 8.10 },
  { username: '09*******', stake: 96.92, target: 4.20 },
  { username: '16*******', stake: 81.23, target: 1.45 },
  { username: '88*******', stake: 76.5, target: 1.58 },
];

export const INITIAL_HISTORY_ROUNDS: HistoryRound[] = [
  {
    id: 'r-101',
    roundNumber: 4812,
    crashPoint: 3.42,
    stake: 100,
    cashoutAt: 2.15,
    payout: 215,
    timestamp: 'منذ دقيقتين',
  },
  {
    id: 'r-100',
    roundNumber: 4811,
    crashPoint: 1.38,
    stake: 50,
    cashoutAt: null,
    payout: 0,
    timestamp: 'منذ 4 دقائق',
  },
  {
    id: 'r-099',
    roundNumber: 4810,
    crashPoint: 6.84,
    stake: 200,
    cashoutAt: 3.1,
    payout: 620,
    timestamp: 'منذ 7 دقائق',
  },
];

function createMaxBetLcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 0x19660d) + 0x3c6ef35f) >>> 0;
    return s / 0x100000000;
  };
}

export const MAX_CRASH_POINT = 35;

export function generateCrashPoint(roundSeed?: number): number {
  const rng =
    roundSeed !== undefined
      ? createMaxBetLcg((roundSeed + 0x9e3779b9) >>> 0)
      : Math.random;
  const r = rng();
  // ~3% instant bust (1.00x) with realistic Crash distribution capped strictly at 35.00x max
  if (r < 0.03) {
    return 1.0;
  }
  const u = Math.min(0.9999, Math.max(0, (r - 0.03) / 0.97));
  const minInv = 1 / MAX_CRASH_POINT;
  const raw = 1 / (1 - u * (1 - minInv));
  const clamped = Math.min(Math.max(raw, 1.01), MAX_CRASH_POINT);
  return Number(clamped.toFixed(2));
}

export function generateSimulatedBets(roundSeed: number): {
  rows: LiveBetRow[];
  totalBetsCount: number;
  baseTotalPool: number;
} {
  const rng = createMaxBetLcg(roundSeed + 0x6a5);
  const rows: LiveBetRow[] = Array.from({ length: 30 }, (_, idx) => {
    const prefix = String(Math.floor(rng() * 100)).padStart(2, '0');
    const r1 = rng();
    const r2 = rng();
    const stake = Math.round((75 + r1 * r2 * 1900) * 100) / 100;
    const targetCashout =
      rng() < 0.62
        ? Math.round((rng() < 0.7 ? 1.01 + rng() * 0.95 : 2 + rng() * 3) * 100) /
          100
        : 9999;

    return {
      id: `bot-${roundSeed}-${idx}`,
      username: `${prefix}*******`,
      stake,
      targetCashout,
      cashedOutAt: null,
      payout: 0,
      status: 'active' as const,
    };
  }).sort((a, b) => b.stake - a.stake);

  const statsRng = createMaxBetLcg(roundSeed + 0x23f3);
  const totalBetsCount = 220 + Math.floor(statsRng() * 175);
  const avgBet = 115 + statsRng() * 95;
  const cents = Math.floor(statsRng() * 100) / 100;
  const targetPool = Number((totalBetsCount * avgBet + cents).toFixed(2));

  return {
    rows,
    totalBetsCount,
    baseTotalPool: targetPool,
  };
}

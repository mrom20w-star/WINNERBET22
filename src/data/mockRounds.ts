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

function seededUnitRandom(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function generateCrashPoint(roundSeed?: number): number {
  const r =
    roundSeed !== undefined
      ? seededUnitRandom(roundSeed * 2654435761)
      : Math.random();
  // Standard ~3% instant bust (1.00x - 1.02x) with 97% RTP heavy-tailed Crash curve
  if (r < 0.03) {
    const sub =
      roundSeed !== undefined
        ? seededUnitRandom(roundSeed * 1597334677 + 17)
        : Math.random();
    return Number((1 + sub * 0.02).toFixed(2));
  }
  const safeR = Math.min(r, 0.9999);
  const raw = 0.97 / (1 - safeR);
  const clamped = Math.min(Math.max(raw, 1.01), 100);
  return Number(clamped.toFixed(2));
}

export function generateSimulatedBets(roundSeed: number): {
  rows: LiveBetRow[];
  totalBetsCount: number;
  baseTotalPool: number;
} {
  // Base simulated rows resembling the exact live feed density
  const rows: LiveBetRow[] = INITIAL_SIMULATED_PLAYERS.map((p, idx) => {
    const jitter = 0.85 + (((roundSeed * 31 + idx * 17) % 35) / 100);
    const stake = Number((p.stake * jitter).toFixed(2));
    const targetShift = (((roundSeed + idx * 7) % 9) - 4) * 0.05;
    const targetCashout = Number(Math.max(1.08, p.target + targetShift).toFixed(2));
    return {
      id: `bot-${roundSeed}-${idx}`,
      username: p.username,
      stake,
      targetCashout,
      cashedOutAt: null,
      payout: 0,
      status: 'active',
    };
  });

  const visibleSum = rows.reduce((acc, r) => acc + r.stake, 0);
  const extraPlayers = 2380 + ((roundSeed * 53) % 240);
  const extraPool = 195000 + ((roundSeed * 4127) % 38000);

  return {
    rows,
    totalBetsCount: rows.length + extraPlayers,
    baseTotalPool: Math.round(visibleSum + extraPool),
  };
}

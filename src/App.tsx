import { useCallback, useEffect, useRef, useState } from 'react';
import { BetPanel } from './components/BetPanel';
import { CrashModals } from './components/CrashModals';
import { CrashScene } from './components/CrashScene';
import { Header } from './components/Header';
import {
  HISTORY_ICON_URI,
  STATS_BETS_ICON_URI,
  STATS_PROFIT_ICON_URI,
  STATS_TOTAL_ICON_URI,
} from './data/crashAssets';
import {
  generateCrashPoint,
  generateSimulatedBets,
  INITIAL_HISTORY_ROUNDS,
} from './data/mockRounds';
import {
  ActiveSheet,
  AutoPlayConfig,
  BetNoticeToast,
  BetSlotState,
  GamePhase,
  HistoryRound,
  LiveBetRow,
  SceneResultBanner,
} from './types/crash';
import {
  fetchCurrentRoundStateFromFirebase,
  FirebasePredictionSignal,
  FirebaseRoundState,
  recordCrashHistoryToFirebase,
  subscribeToCurrentRoundFromFirebase,
  subscribeToFirebasePredictions,
  syncRoundPhaseToFirebase,
} from './services/firebaseCrash';
const WAITING_DURATION_MS = 4800;
const CRASH_PAUSE_MS = 2200;
const FLIGHT_GROWTH_K = 0.09;
const INITIAL_BALANCE = 1000;
const SESSION_STORAGE_KEY = 'maxbet_crash_session_v1';
const GLOBAL_EPOCH_MS = Date.UTC(2026, 10, 15, 0, 0, 0);

const HISTORY_ICON_STYLE = {
  maskImage: `url("${HISTORY_ICON_URI}")`,
  WebkitMaskImage: `url("${HISTORY_ICON_URI}")`,
};
const STATS_BETS_ICON_STYLE = {
  maskImage: `url("${STATS_BETS_ICON_URI}")`,
  WebkitMaskImage: `url("${STATS_BETS_ICON_URI}")`,
};
const STATS_TOTAL_ICON_STYLE = {
  maskImage: `url("${STATS_TOTAL_ICON_URI}")`,
  WebkitMaskImage: `url("${STATS_TOTAL_ICON_URI}")`,
};
const STATS_PROFIT_ICON_STYLE = {
  maskImage: `url("${STATS_PROFIT_ICON_URI}")`,
  WebkitMaskImage: `url("${STATS_PROFIT_ICON_URI}")`,
};

function createInitialSlot(id: 0 | 1): BetSlotState {
  return {
    id,
    inputValue: '20',
    activeBet: null,
    queuedBet: null,
    autoConfig: {
      enabled: false,
      baseStake: 20,
      autoCashout: 2,
      roundsRemaining: null,
      onWin: 'continue',
      onLoss: 'continue',
    },
  };
}

interface PersistedCrashSession {
  roundNumber: number;
  roundStartedAt: number;
  crashPoint: number;
  balance: number;
  slots: [BetSlotState, BetSlotState];
  historyRounds: HistoryRound[];
}

interface ResolvedTimelineState {
  roundNumber: number;
  roundStartedAt: number;
  crashPoint: number;
  phase: GamePhase;
  phaseElapsedMs: number;
  countdownSeconds: number;
  crashedMultiplier: number;
  flightCrashedSec: number;
  balance: number;
  slots: [BetSlotState, BetSlotState];
  historyRounds: HistoryRound[];
  simulatedRows: LiveBetRow[];
  baseStats: { count: number; pool: number };
}

function buildSimulatedForState(
  roundNumber: number,
  phase: GamePhase,
  phaseElapsedMs: number,
  crashPoint: number
) {
  const sim = generateSimulatedBets(roundNumber);
  if (phase === 'waiting') {
    return {
      rows: sim.rows,
      baseStats: { count: sim.totalBetsCount, pool: sim.baseTotalPool },
    };
  }
  const liveMult =
    phase === 'flight'
      ? Math.exp(FLIGHT_GROWTH_K * (phaseElapsedMs / 1000))
      : crashPoint;
  const rows: LiveBetRow[] = sim.rows.map((row) => {
    const won =
      phase === 'flight'
        ? liveMult >= row.targetCashout
        : row.targetCashout < crashPoint;
    if (won) {
      return {
        ...row,
        cashedOutAt: row.targetCashout,
        payout: Number((row.stake * row.targetCashout).toFixed(2)),
        status: 'win',
      };
    }
    return phase === 'crashed' ? { ...row, status: 'loss', payout: 0 } : row;
  });
  return {
    rows,
    baseStats: { count: sim.totalBetsCount, pool: sim.baseTotalPool },
  };
}

function resolveTimelineToNow(
  seed: PersistedCrashSession,
  nowEpoch: number
): ResolvedTimelineState {
  let roundNumber = seed.roundNumber;
  let roundStartedAt = seed.roundStartedAt;
  let crashPoint = seed.crashPoint;
  let balance = seed.balance;
  let slots: [BetSlotState, BetSlotState] = [
    { ...seed.slots[0], autoConfig: { ...seed.slots[0].autoConfig } },
    { ...seed.slots[1], autoConfig: { ...seed.slots[1].autoConfig } },
  ];
  let historyRounds = [...seed.historyRounds];

  const settleCompletedRound = (targetCrash: number, rNum: number) => {
    let roundStake = 0;
    let roundPayout = 0;
    let bestCashout: number | null = null;
    for (const idx of [0, 1] as const) {
      const s = slots[idx];
      if (!s.activeBet) continue;
      roundStake += s.activeBet.stake;
      if (s.activeBet.cashedOutAt !== null) {
        roundPayout += s.activeBet.payout;
        bestCashout =
          bestCashout === null
            ? s.activeBet.cashedOutAt
            : Math.max(bestCashout, s.activeBet.cashedOutAt);
      } else if (
        s.autoConfig.enabled &&
        s.autoConfig.autoCashout < targetCrash
      ) {
        const autoPay = Number(
          (s.activeBet.stake * s.autoConfig.autoCashout).toFixed(2)
        );
        balance = Number((balance + autoPay).toFixed(2));
        roundPayout += autoPay;
        bestCashout =
          bestCashout === null
            ? s.autoConfig.autoCashout
            : Math.max(bestCashout, s.autoConfig.autoCashout);
        slots[idx] = {
          ...s,
          activeBet: {
            ...s.activeBet,
            cashedOutAt: s.autoConfig.autoCashout,
            payout: autoPay,
          },
        };
      }
    }
    if (roundStake > 0 && !historyRounds.some((h) => h.roundNumber === rNum)) {
      historyRounds = [
        {
          id: `r-${rNum}-${nowEpoch}`,
          roundNumber: rNum,
          crashPoint: targetCrash,
          stake: Number(roundStake.toFixed(2)),
          cashoutAt: bestCashout,
          payout: Number(roundPayout.toFixed(2)),
          timestamp: 'منذ لحظات',
        },
        ...historyRounds.slice(0, 29),
      ];
    }
  };

  if (nowEpoch - roundStartedAt > 45 * 60 * 1000) {
    settleCompletedRound(crashPoint, roundNumber);
    for (const idx of [0, 1] as const) {
      if (slots[idx].queuedBet !== null) {
        balance = Number((balance + (slots[idx].queuedBet ?? 0)).toFixed(2));
      }
      slots[idx] = {
        ...slots[idx],
        activeBet: null,
        queuedBet: null,
        autoConfig: { ...slots[idx].autoConfig, enabled: false },
      };
    }
    const avgCycle = 15200;
    const gap = nowEpoch - roundStartedAt;
    roundNumber += Math.max(1, Math.floor(gap / avgCycle));
    roundStartedAt = nowEpoch - (gap % avgCycle);
    crashPoint = generateCrashPoint(roundNumber);
  }

  let phase: GamePhase = 'waiting';
  let phaseElapsedMs = 0;

  for (let steps = 0; steps < 300; steps++) {
    const flightStartedAt = roundStartedAt + WAITING_DURATION_MS;
    const flightDurationMs =
      (Math.log(Math.max(1.01, crashPoint)) / FLIGHT_GROWTH_K) * 1000;
    const crashedAt = flightStartedAt + flightDurationMs;
    const roundEndedAt = crashedAt + CRASH_PAUSE_MS;

    if (nowEpoch < flightStartedAt) {
      phase = 'waiting';
      phaseElapsedMs = Math.max(0, nowEpoch - roundStartedAt);
      break;
    }

    if (nowEpoch < crashedAt) {
      phase = 'flight';
      phaseElapsedMs = Math.max(0, nowEpoch - flightStartedAt);
      const liveMult = Math.exp(FLIGHT_GROWTH_K * (phaseElapsedMs / 1000));
      for (const idx of [0, 1] as const) {
        const s = slots[idx];
        if (
          s.activeBet &&
          s.activeBet.cashedOutAt === null &&
          s.autoConfig.enabled &&
          liveMult >= s.autoConfig.autoCashout
        ) {
          const payout = Number(
            (s.activeBet.stake * s.autoConfig.autoCashout).toFixed(2)
          );
          balance = Number((balance + payout).toFixed(2));
          slots[idx] = {
            ...s,
            activeBet: {
              ...s.activeBet,
              cashedOutAt: s.autoConfig.autoCashout,
              payout,
            },
          };
        }
      }
      break;
    }

    if (nowEpoch < roundEndedAt) {
      phase = 'crashed';
      phaseElapsedMs = Math.max(0, nowEpoch - crashedAt);
      settleCompletedRound(crashPoint, roundNumber);
      break;
    }

    // Round finished while away -> settle and advance to next round
    settleCompletedRound(crashPoint, roundNumber);
    let deducted = 0;
    for (const idx of [0, 1] as const) {
      const s = slots[idx];
      const wonPrev = s.activeBet !== null && s.activeBet.cashedOutAt !== null;
      const lostPrev =
        s.activeBet !== null && s.activeBet.cashedOutAt === null;
      const nextAuto = { ...s.autoConfig };
      if (nextAuto.enabled && s.activeBet !== null) {
        if (wonPrev && nextAuto.onWin === 'stop') nextAuto.enabled = false;
        else if (lostPrev && nextAuto.onLoss === 'stop')
          nextAuto.enabled = false;
        else if (nextAuto.roundsRemaining !== null) {
          const left = nextAuto.roundsRemaining - 1;
          nextAuto.roundsRemaining = left <= 0 ? null : left;
          if (left <= 0) nextAuto.enabled = false;
        }
      }
      let nextActive: BetSlotState['activeBet'] = null;
      if (s.queuedBet !== null) {
        nextActive = { stake: s.queuedBet, cashedOutAt: null, payout: 0 };
      } else if (nextAuto.enabled && balance - deducted >= nextAuto.baseStake) {
        deducted += nextAuto.baseStake;
        nextActive = {
          stake: nextAuto.baseStake,
          cashedOutAt: null,
          payout: 0,
        };
      }
      slots[idx] = {
        ...s,
        activeBet: nextActive,
        queuedBet: null,
        autoConfig: nextAuto,
      };
    }
    if (deducted > 0) {
      balance = Number(Math.max(0, balance - deducted).toFixed(2));
    }

    roundNumber += 1;
    roundStartedAt = roundEndedAt;
    crashPoint = generateCrashPoint(roundNumber);
  }

  const remainingWait = Math.max(0, WAITING_DURATION_MS - phaseElapsedMs);
  const countdownSeconds =
    phase === 'waiting'
      ? Math.max(
          1,
          Math.min(6, Math.ceil((remainingWait / WAITING_DURATION_MS) * 6))
        )
      : 6;
  const flightCrashedSec =
    phase === 'crashed'
      ? Math.log(Math.max(1, crashPoint)) / FLIGHT_GROWTH_K
      : 0;
  const crashedMultiplier = phase === 'crashed' ? crashPoint : 1.0;

  const simState = buildSimulatedForState(
    roundNumber,
    phase,
    phaseElapsedMs,
    crashPoint
  );

  return {
    roundNumber,
    roundStartedAt,
    crashPoint,
    phase,
    phaseElapsedMs,
    countdownSeconds,
    crashedMultiplier,
    flightCrashedSec,
    balance,
    slots,
    historyRounds,
    simulatedRows: simState.rows,
    baseStats: simState.baseStats,
  };
}

function loadBootSession(): {
  resolved: ResolvedTimelineState;
  hadSavedSession: boolean;
} {
  const now = Date.now();
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PersistedCrashSession>;
      if (
        typeof parsed.roundNumber === 'number' &&
        typeof parsed.roundStartedAt === 'number' &&
        typeof parsed.crashPoint === 'number' &&
        parsed.roundStartedAt > 0 &&
        parsed.crashPoint >= 1 &&
        Array.isArray(parsed.slots) &&
        parsed.slots.length === 2
      ) {
        return {
          hadSavedSession: true,
          resolved: resolveTimelineToNow(
            {
              roundNumber: parsed.roundNumber,
              roundStartedAt: parsed.roundStartedAt,
              crashPoint: parsed.crashPoint,
              balance:
                typeof parsed.balance === 'number'
                  ? parsed.balance
                  : INITIAL_BALANCE,
              slots: parsed.slots as [BetSlotState, BetSlotState],
              historyRounds: Array.isArray(parsed.historyRounds)
                ? parsed.historyRounds
                : INITIAL_HISTORY_ROUNDS,
            },
            now
          ),
        };
      }
    }
  } catch {
    // Fallback to global epoch timeline below
  }

  const cycleMs = 15200;
  const sinceEpoch = Math.max(0, now - GLOBAL_EPOCH_MS);
  const estRound = 4813 + Math.floor(sinceEpoch / cycleMs);
  const roundStartedAt = now - (sinceEpoch % cycleMs);
  return {
    hadSavedSession: false,
    resolved: resolveTimelineToNow(
      {
        roundNumber: estRound,
        roundStartedAt,
        crashPoint: generateCrashPoint(estRound),
        balance: INITIAL_BALANCE,
        slots: [createInitialSlot(0), createInitialSlot(1)],
        historyRounds: INITIAL_HISTORY_ROUNDS,
      },
      now
    ),
  };
}

export default function App() {
  const bootRef = useRef<{
    resolved: ResolvedTimelineState;
    hadSavedSession: boolean;
    initialPerfNow: number;
  } | null>(null);
  if (bootRef.current === null) {
    bootRef.current = {
      ...loadBootSession(),
      initialPerfNow: performance.now(),
    };
  }
  const initial = bootRef.current.resolved;
  const initialPhaseStartPerf =
    bootRef.current.initialPerfNow - initial.phaseElapsedMs;

  const [balance, setBalance] = useState<number>(initial.balance);
  const [phase, setPhase] = useState<GamePhase>(initial.phase);
  const [countdownSeconds, setCountdownSeconds] = useState<number>(
    initial.countdownSeconds
  );
  const [flightStartTime, setFlightStartTime] = useState<number>(
    initialPhaseStartPerf
  );
  const [crashedMultiplier, setCrashedMultiplier] = useState<number>(
    initial.crashedMultiplier
  );
  const [flightCrashedSec, setFlightCrashedSec] = useState<number>(
    initial.flightCrashedSec
  );
  const [roundNumber, setRoundNumber] = useState<number>(initial.roundNumber);

  const [slots, setSlots] = useState<[BetSlotState, BetSlotState]>(
    initial.slots
  );

  const [simulatedRows, setSimulatedRows] = useState<LiveBetRow[]>(
    initial.simulatedRows
  );
  const [baseStats, setBaseStats] = useState<{
    count: number;
    pool: number;
  }>(initial.baseStats);

  const [historyRounds, setHistoryRounds] = useState<HistoryRound[]>(
    initial.historyRounds
  );
  const [activeSheet, setActiveSheet] = useState<ActiveSheet>(null);
  const [betNotice, setBetNotice] = useState<BetNoticeToast | null>(null);
  const [resultBanner, setResultBanner] = useState<SceneResultBanner | null>(null);
  const [isRoundTransition, setIsRoundTransition] = useState<boolean>(false);
  const [notifications, setNotifications] = useState([
    {
      id: 'n-1',
      title: 'مرحباً بك في Crash — MaxBet',
      body: 'توقّع لحظة الانفجار واسحب أرباحك في الوقت المناسب. يمكنك شحن رصيدك التجريبي من أيقونة المحفظة بالأعلى.',
      time: 'الآن',
      unread: true,
    },
  ]);

  const balanceRef = useRef(balance);
  balanceRef.current = balance;

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const slotsRef = useRef(slots);
  slotsRef.current = slots;

  const roundNumberRef = useRef(roundNumber);
  roundNumberRef.current = roundNumber;

  const historyRoundsRef = useRef(historyRounds);
  historyRoundsRef.current = historyRounds;

  const crashPointRef = useRef<number>(initial.crashPoint);
  const roundStartedAtRef = useRef<number>(initial.roundStartedAt);
  const pendingFirebasePredictionRef = useRef<FirebasePredictionSignal | null>(
    null
  );
  const consumedFirebaseTokensRef = useRef<Set<string>>(new Set());
  const phaseStartRef = useRef<number>(initialPhaseStartPerf);
  const lastSyncEpochRef = useRef<number>(Date.now());
  const toastCounterRef = useRef<number>(1);

  const persistSession = useCallback(() => {
    try {
      const payload: PersistedCrashSession = {
        roundNumber: roundNumberRef.current,
        roundStartedAt: roundStartedAtRef.current,
        crashPoint: crashPointRef.current,
        balance: balanceRef.current,
        slots: slotsRef.current,
        historyRounds: historyRoundsRef.current,
      };
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota errors in restricted embeds
    }
  }, []);

  const applyResolvedState = useCallback(
    (resolved: ResolvedTimelineState) => {
      const nowPerf = performance.now();
      const startPerf = nowPerf - resolved.phaseElapsedMs;

      roundNumberRef.current = resolved.roundNumber;
      roundStartedAtRef.current = resolved.roundStartedAt;
      crashPointRef.current = resolved.crashPoint;
      phaseRef.current = resolved.phase;
      phaseStartRef.current = startPerf;
      balanceRef.current = resolved.balance;
      slotsRef.current = resolved.slots;
      historyRoundsRef.current = resolved.historyRounds;

      setRoundNumber(resolved.roundNumber);
      setPhase(resolved.phase);
      setCountdownSeconds(resolved.countdownSeconds);
      setFlightStartTime(startPerf);
      setCrashedMultiplier(resolved.crashedMultiplier);
      setFlightCrashedSec(resolved.flightCrashedSec);
      setBalance(resolved.balance);
      setSlots(resolved.slots);
      setHistoryRounds(resolved.historyRounds);
      setSimulatedRows(resolved.simulatedRows);
      setBaseStats(resolved.baseStats);
      setIsRoundTransition(false);
    },
    []
  );

  const resolveRoundCrashPoint = useCallback((targetRound: number) => {
    const signal = pendingFirebasePredictionRef.current;
    if (
      signal &&
      !consumedFirebaseTokensRef.current.has(signal.token) &&
      (signal.roundNumber === undefined || signal.roundNumber === targetRound)
    ) {
      consumedFirebaseTokensRef.current.add(signal.token);
      pendingFirebasePredictionRef.current = null;
      return signal.crashPoint;
    }
    return generateCrashPoint(targetRound);
  }, []);

  useEffect(() => {
    persistSession();
  }, [balance, slots, historyRounds, phase, roundNumber, persistSession]);

  useEffect(() => {
    const handleBackground = () => {
      persistSession();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        persistSession();
      } else {
        const now = Date.now();
        if (now - lastSyncEpochRef.current > 2000) {
          const reconciled = resolveTimelineToNow(
            {
              roundNumber: roundNumberRef.current,
              roundStartedAt: roundStartedAtRef.current,
              crashPoint: crashPointRef.current,
              balance: balanceRef.current,
              slots: slotsRef.current,
              historyRounds: historyRoundsRef.current,
            },
            now
          );
          applyResolvedState(reconciled);
          lastSyncEpochRef.current = now;
        }
      }
    };

    window.addEventListener('pagehide', handleBackground);
    window.addEventListener('beforeunload', handleBackground);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', handleBackground);
      window.removeEventListener('beforeunload', handleBackground);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [applyResolvedState, persistSession]);

  useEffect(() => {
    const maybeAdoptRemoteRound = (
      remote: FirebaseRoundState,
      isInitialFetch: boolean
    ) => {
      const now = Date.now();
      if (now - remote.roundStartedAt > 15 * 60 * 1000) {
        return;
      }

      const isNewerRound = remote.roundNumber > roundNumberRef.current;
      const isDifferentSameRound =
        remote.roundNumber === roundNumberRef.current &&
        Math.abs(remote.roundStartedAt - roundStartedAtRef.current) > 1500 &&
        (isInitialFetch || remote.updatedAt > lastSyncEpochRef.current);

      if (
        (!bootRef.current?.hadSavedSession && isInitialFetch) ||
        isNewerRound ||
        isDifferentSameRound
      ) {
        const reconciled = resolveTimelineToNow(
          {
            roundNumber: remote.roundNumber,
            roundStartedAt: remote.roundStartedAt,
            crashPoint: remote.crashPoint,
            balance: balanceRef.current,
            slots: slotsRef.current,
            historyRounds: historyRoundsRef.current,
          },
          now
        );
        applyResolvedState(reconciled);
        lastSyncEpochRef.current = now;
        persistSession();
      }
    };

    fetchCurrentRoundStateFromFirebase().then((remote) => {
      if (remote) {
        maybeAdoptRemoteRound(remote, true);
      }
      syncRoundPhaseToFirebase({
        roundNumber: roundNumberRef.current,
        phase: phaseRef.current,
        crashPoint: crashPointRef.current,
        roundStartedAt: roundStartedAtRef.current,
        flightStartedAt: roundStartedAtRef.current + WAITING_DURATION_MS,
      });
    });

    const unsubRound = subscribeToCurrentRoundFromFirebase((remote) => {
      maybeAdoptRemoteRound(remote, false);
    });

    const unsubPredictions = subscribeToFirebasePredictions((signal) => {
      if (consumedFirebaseTokensRef.current.has(signal.token)) {
        return;
      }

      if (
        phaseRef.current === 'waiting' &&
        (signal.roundNumber === undefined ||
          signal.roundNumber === roundNumberRef.current)
      ) {
        consumedFirebaseTokensRef.current.add(signal.token);
        crashPointRef.current = signal.crashPoint;
        syncRoundPhaseToFirebase({
          roundNumber: roundNumberRef.current,
          phase: 'waiting',
          crashPoint: signal.crashPoint,
          roundStartedAt: roundStartedAtRef.current,
          flightStartedAt: roundStartedAtRef.current + WAITING_DURATION_MS,
        });
        persistSession();
        return;
      }

      pendingFirebasePredictionRef.current = signal;
    });

    return () => {
      unsubRound();
      unsubPredictions();
    };
  }, [applyResolvedState, persistSession]);

  const showNotice = useCallback((type: 'success' | 'error', text: string) => {
    const id = ++toastCounterRef.current;
    setBetNotice({ id, type, text });
    window.setTimeout(() => {
      setBetNotice((curr) => (curr?.id === id ? null : curr));
    }, 2200);
  }, []);

  const showBanner = useCallback((type: 'win' | 'loss', text: string) => {
    const id = ++toastCounterRef.current;
    setResultBanner({ id, type, text });
    window.setTimeout(() => {
      setResultBanner((curr) => (curr?.id === id ? null : curr));
    }, 2400);
  }, []);

  const settleCashout = useCallback(
    (slotId: 0 | 1, atMultiplier: number) => {
      const targetSlot = slotsRef.current[slotId];
      if (!targetSlot.activeBet || targetSlot.activeBet.cashedOutAt !== null) {
        return;
      }
      const payout = Number(
        (targetSlot.activeBet.stake * atMultiplier).toFixed(2)
      );

      setSlots((prev) => {
        const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
        const curr = next[slotId];
        if (!curr.activeBet || curr.activeBet.cashedOutAt !== null) return prev;
        next[slotId] = {
          ...curr,
          activeBet: {
            ...curr.activeBet,
            cashedOutAt: atMultiplier,
            payout,
          },
        };
        return next;
      });

      setBalance((b) => Number((b + payout).toFixed(2)));
      showBanner('win', `ربحت ${payout.toFixed(2)} ج.م`);
    },
    [showBanner]
  );

  // Main game phase loop driven by requestAnimationFrame
  useEffect(() => {
    let rafId = 0;

    const tick = (now: number) => {
      lastSyncEpochRef.current = Date.now();
      const elapsed = now - phaseStartRef.current;
      const currentPhase = phaseRef.current;

      if (currentPhase === 'waiting') {
        const remainingMs = Math.max(0, WAITING_DURATION_MS - elapsed);
        const sec = Math.max(
          1,
          Math.min(6, Math.ceil((remainingMs / WAITING_DURATION_MS) * 6))
        );
        setCountdownSeconds((prev) => (prev !== sec ? sec : prev));

        if (elapsed >= WAITING_DURATION_MS) {
          const pending = pendingFirebasePredictionRef.current;
          if (
            pending &&
            !consumedFirebaseTokensRef.current.has(pending.token) &&
            (pending.roundNumber === undefined ||
              pending.roundNumber === roundNumberRef.current)
          ) {
            consumedFirebaseTokensRef.current.add(pending.token);
            crashPointRef.current = pending.crashPoint;
            pendingFirebasePredictionRef.current = null;
          }

          phaseStartRef.current = now;
          phaseRef.current = 'flight';
          setFlightStartTime(now);
          setPhase('flight');
          setIsRoundTransition(false);
          syncRoundPhaseToFirebase({
            roundNumber: roundNumberRef.current,
            phase: 'flight',
            crashPoint: crashPointRef.current,
            roundStartedAt: roundStartedAtRef.current,
            flightStartedAt: Date.now(),
          });
        }
      } else if (currentPhase === 'flight') {
        const sec = Math.max(0, elapsed / 1000);
        const nextMult = Number(Math.exp(FLIGHT_GROWTH_K * sec).toFixed(2));
        const crashTarget = crashPointRef.current;

        if (nextMult >= crashTarget) {
          // Crash occurred!
          const crashSec = Math.log(Math.max(1, crashTarget)) / FLIGHT_GROWTH_K;
          phaseStartRef.current = now;
          phaseRef.current = 'crashed';
          setFlightCrashedSec(crashSec);
          setCrashedMultiplier(crashTarget);
          setPhase('crashed');
          syncRoundPhaseToFirebase({
            roundNumber: roundNumberRef.current,
            phase: 'crashed',
            crashPoint: crashTarget,
            roundStartedAt: roundStartedAtRef.current,
            flightStartedAt: roundStartedAtRef.current + WAITING_DURATION_MS,
          });
          recordCrashHistoryToFirebase({
            roundNumber: roundNumberRef.current,
            crashPoint: crashTarget,
          });

          // Settle simulated players who hadn't cashed out before crashTarget
          setSimulatedRows((prev) =>
            prev.map((row) =>
              row.cashedOutAt !== null
                ? row
                : { ...row, status: 'loss', payout: 0 }
            )
          );

          // Settle user bets & update history / auto-play rules
          const currentSlots = slotsRef.current;
          let roundStake = 0;
          let roundPayout = 0;
          let bestCashout: number | null = null;
          let hadLoss = false;

          currentSlots.forEach((slot) => {
            if (slot.activeBet) {
              roundStake += slot.activeBet.stake;
              if (slot.activeBet.cashedOutAt !== null) {
                roundPayout += slot.activeBet.payout;
                bestCashout =
                  bestCashout === null
                    ? slot.activeBet.cashedOutAt
                    : Math.max(bestCashout, slot.activeBet.cashedOutAt);
              } else {
                hadLoss = true;
              }
            }
          });

          if (roundStake > 0) {
            const newHistory: HistoryRound = {
              id: `r-${roundNumberRef.current}-${Date.now()}`,
              roundNumber: roundNumberRef.current,
              crashPoint: crashTarget,
              stake: Number(roundStake.toFixed(2)),
              cashoutAt: bestCashout,
              payout: Number(roundPayout.toFixed(2)),
              timestamp: 'الآن',
            };
            setHistoryRounds((prev) => [newHistory, ...prev.slice(0, 29)]);

            if (hadLoss && roundPayout === 0) {
              showBanner('loss', `خسرت ${roundStake.toFixed(2)} ج.م`);
            }
          }
        } else {

          // Settle simulated players hitting targetCashout
          setSimulatedRows((prev) => {
            let changed = false;
            const mapped = prev.map((row) => {
              if (row.cashedOutAt === null && nextMult >= row.targetCashout) {
                changed = true;
                return {
                  ...row,
                  cashedOutAt: row.targetCashout,
                  payout: Number((row.stake * row.targetCashout).toFixed(2)),
                  status: 'win' as const,
                };
              }
              return row;
            });
            return changed ? mapped : prev;
          });

          // Auto-cashout check for user slots
          slotsRef.current.forEach((slot) => {
            if (
              slot.activeBet &&
              slot.activeBet.cashedOutAt === null &&
              slot.autoConfig.enabled &&
              nextMult >= slot.autoConfig.autoCashout
            ) {
              settleCashout(slot.id, slot.autoConfig.autoCashout);
            }
          });
        }
      } else if (currentPhase === 'crashed') {
        if (elapsed >= CRASH_PAUSE_MS) {
          // Prepare next round
          const nextRound = roundNumberRef.current + 1;
          roundNumberRef.current = nextRound;
          setRoundNumber(nextRound);

          const sim = generateSimulatedBets(nextRound);
          setSimulatedRows(sim.rows);
          setBaseStats({ count: sim.totalBetsCount, pool: sim.baseTotalPool });

          // Promote queued bets & handle auto-play for next round
          let deductedTotal = 0;
          const prevSlots = slotsRef.current;
          const updatedSlots: [BetSlotState, BetSlotState] = [
            prevSlots[0],
            prevSlots[1],
          ];

          for (const idx of [0, 1] as const) {
            const s = prevSlots[idx];
            const wonPrev =
              s.activeBet !== null && s.activeBet.cashedOutAt !== null;
            const lostPrev =
              s.activeBet !== null && s.activeBet.cashedOutAt === null;

            let nextAuto = { ...s.autoConfig };
            if (nextAuto.enabled && s.activeBet !== null) {
              if (wonPrev && nextAuto.onWin === 'stop') {
                nextAuto.enabled = false;
              } else if (lostPrev && nextAuto.onLoss === 'stop') {
                nextAuto.enabled = false;
              } else if (nextAuto.roundsRemaining !== null) {
                const left = nextAuto.roundsRemaining - 1;
                if (left <= 0) {
                  nextAuto.enabled = false;
                  nextAuto.roundsRemaining = null;
                } else {
                  nextAuto.roundsRemaining = left;
                }
              }
            }

            let nextActiveBet: BetSlotState['activeBet'] = null;
            if (s.queuedBet !== null) {
              nextActiveBet = {
                stake: s.queuedBet,
                cashedOutAt: null,
                payout: 0,
              };
            } else if (nextAuto.enabled) {
              const available = balanceRef.current - deductedTotal;
              if (available >= nextAuto.baseStake) {
                deductedTotal += nextAuto.baseStake;
                nextActiveBet = {
                  stake: nextAuto.baseStake,
                  cashedOutAt: null,
                  payout: 0,
                };
              } else {
                nextAuto.enabled = false;
                showNotice('error', 'الرصيد غير كافٍ لإكمال التشغيل التلقائي');
              }
            }

            updatedSlots[idx] = {
              ...s,
              activeBet: nextActiveBet,
              queuedBet: null,
              autoConfig: nextAuto,
            };
          }

          if (deductedTotal > 0) {
            setBalance((b) => Number(Math.max(0, b - deductedTotal).toFixed(2)));
          }
          setSlots(updatedSlots);

          const newRoundStartEpoch = Date.now();
          roundStartedAtRef.current = newRoundStartEpoch;
          crashPointRef.current = resolveRoundCrashPoint(nextRound);
          syncRoundPhaseToFirebase({
            roundNumber: nextRound,
            phase: 'waiting',
            crashPoint: crashPointRef.current,
            roundStartedAt: newRoundStartEpoch,
            flightStartedAt: newRoundStartEpoch + WAITING_DURATION_MS,
          });

          phaseStartRef.current = now;
          phaseRef.current = 'waiting';
          setPhase('waiting');
          setCountdownSeconds(6);
          setCrashedMultiplier(1.0);
          setFlightCrashedSec(0);
          setIsRoundTransition(true);
          window.setTimeout(() => setIsRoundTransition(false), 320);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [resolveRoundCrashPoint, settleCashout, showBanner, showNotice]);

  const handleChangeInput = (slotId: 0 | 1, value: string) => {
    const sanitized = value.replace(/[^0-9.]/g, '');
    setSlots((prev) => {
      const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
      next[slotId] = { ...next[slotId], inputValue: sanitized };
      return next;
    });
  };

  const handlePickPreset = (slotId: 0 | 1, amount: number) => {
    setSlots((prev) => {
      const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
      next[slotId] = { ...next[slotId], inputValue: String(amount) };
      return next;
    });
  };

  const handleClearInput = (slotId: 0 | 1) => {
    setSlots((prev) => {
      const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
      next[slotId] = { ...next[slotId], inputValue: '' };
      return next;
    });
  };

  const handleAction = (slotId: 0 | 1) => {
    const slot = slots[slotId];
    const currPhase = phase;

    // 1. Live Cashout during flight
    if (
      currPhase === 'flight' &&
      slot.activeBet !== null &&
      slot.activeBet.cashedOutAt === null
    ) {
      const elapsedSec = Math.max(
        0,
        (performance.now() - phaseStartRef.current) / 1000
      );
      const liveMult = Number(Math.exp(FLIGHT_GROWTH_K * elapsedSec).toFixed(2));
      if (liveMult < crashPointRef.current) {
        settleCashout(slotId, Math.max(1.0, liveMult));
      }
      return;
    }

    // 2. Cancel active bet during waiting countdown
    if (currPhase === 'waiting' && slot.activeBet !== null) {
      const refund = slot.activeBet.stake;
      setSlots((prev) => {
        const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
        next[slotId] = { ...next[slotId], activeBet: null };
        return next;
      });
      setBalance((b) => Number((b + refund).toFixed(2)));
      showNotice('success', 'تم إلغاء الرهان واسترداد القيمة');
      return;
    }

    // 3. Cancel queued bet for next round
    if (slot.queuedBet !== null) {
      const refund = slot.queuedBet;
      setSlots((prev) => {
        const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
        next[slotId] = { ...next[slotId], queuedBet: null };
        return next;
      });
      setBalance((b) => Number((b + refund).toFixed(2)));
      showNotice('success', 'تم إلغاء الرهان المنتظر');
      return;
    }

    // 4. Already cashed out in this flight round -> do nothing until next round
    if (
      currPhase === 'flight' &&
      slot.activeBet !== null &&
      slot.activeBet.cashedOutAt !== null
    ) {
      return;
    }

    // 5. Place new bet (either immediate in waiting or queued for next round)
    const stake = Number.parseFloat(slot.inputValue);
    if (Number.isNaN(stake) || stake < 1) {
      showNotice('error', 'أدخل قيمة رهان صالحة (1 EGP على الأقل)');
      return;
    }
    if (stake > balance) {
      showNotice('error', 'الرصيد غير كافٍ — يمكنك الإيداع من المحفظة');
      return;
    }

    const roundedStake = Number(stake.toFixed(2));
    setBalance((b) => Number((b - roundedStake).toFixed(2)));

    if (currPhase === 'waiting') {
      setSlots((prev) => {
        const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
        next[slotId] = {
          ...next[slotId],
          activeBet: { stake: roundedStake, cashedOutAt: null, payout: 0 },
        };
        return next;
      });
      showNotice('success', `تم وضع رهان ${roundedStake} ج.م`);
    } else {
      setSlots((prev) => {
        const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
        next[slotId] = { ...next[slotId], queuedBet: roundedStake };
        return next;
      });
      showNotice('success', 'تم تجهيز الرهان للجولة القادمة');
    }
  };

  const handleSaveAutoPlay = (slotId: 0 | 1, config: AutoPlayConfig) => {
    const slot = slots[slotId];
    const shouldPlaceNow =
      phase === 'waiting' &&
      slot.activeBet === null &&
      balance >= config.baseStake;

    if (shouldPlaceNow) {
      setBalance((b) => Number((b - config.baseStake).toFixed(2)));
    }

    setSlots((prev) => {
      const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
      next[slotId] = {
        ...next[slotId],
        inputValue: String(config.baseStake),
        autoConfig: config,
        activeBet: shouldPlaceNow
          ? { stake: config.baseStake, cashedOutAt: null, payout: 0 }
          : next[slotId].activeBet,
      };
      return next;
    });
    showNotice('success', `تم تفعيل التشغيل التلقائي عند x${config.autoCashout}`);
  };

  const handleDisableAutoPlay = (slotId: 0 | 1) => {
    setSlots((prev) => {
      const next: [BetSlotState, BetSlotState] = [prev[0], prev[1]];
      next[slotId] = {
        ...next[slotId],
        autoConfig: { ...next[slotId].autoConfig, enabled: false },
      };
      return next;
    });
    showNotice('success', 'تم إيقاف التشغيل التلقائي');
  };

  const handleDeposit = (amount: number) => {
    setBalance((b) => Number((b + amount).toFixed(2)));
    showNotice('success', `تم إضافة ${amount.toFixed(2)} ج.م إلى الرصيد`);
  };

  // Build user live bet rows so they appear highlighted with .is-me at top of the list
  const userLiveRows: LiveBetRow[] = [];
  slots.forEach((slot) => {
    if (slot.activeBet) {
      const isWin = slot.activeBet.cashedOutAt !== null;
      const isLoss = phase === 'crashed' && !isWin;
      userLiveRows.push({
        id: `me-${slot.id}`,
        username: `أنت (${slot.id + 1})`,
        stake: slot.activeBet.stake,
        targetCashout: slot.autoConfig.enabled ? slot.autoConfig.autoCashout : 0,
        cashedOutAt: slot.activeBet.cashedOutAt,
        payout: slot.activeBet.payout,
        isMe: true,
        status: isWin ? 'win' : isLoss ? 'loss' : 'active',
      });
    }
  });

  const combinedRows = [...userLiveRows, ...simulatedRows];

  const userStakeSum = userLiveRows.reduce((acc, r) => acc + r.stake, 0);
  const simProfitSum = simulatedRows.reduce(
    (acc, r) => acc + (r.cashedOutAt !== null ? r.payout : 0),
    0
  );
  const userProfitSum = userLiveRows.reduce((acc, r) => acc + r.payout, 0);

  const displayBetsCount = baseStats.count + userLiveRows.length;
  const displayTotalPool = Math.round(baseStats.pool + userStakeSum);
  const displayTotalProfit = Math.round(
    simProfitSum * 6.85 + userProfitSum + (phase === 'waiting' ? 0 : 12400)
  );

  const unreadCount = notifications.filter((n) => n.unread).length;
  const activeAutoSlot =
    activeSheet?.type === 'auto' ? slots[activeSheet.slotId] : undefined;

  return (
    <div id="top">
      <Header
        balance={balance}
        unreadCount={unreadCount}
        onOpenDeposit={() => setActiveSheet({ type: 'deposit' })}
        onOpenNotifications={() => {
          setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
          setActiveSheet({ type: 'notifications' });
        }}
        onBack={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      />

      <div className="c1x">
        <main className="recording-shell">
          <div className="game-canvas" dir="rtl">
            <div className="game-content">
              <nav className="game-tabs" aria-label="تبويبات اللعبة">
                <button
                  type="button"
                  className="terms-tab"
                  onClick={() => setActiveSheet({ type: 'terms' })}
                >
                  الأحكام و الشروط
                </button>
                <button
                  type="button"
                  className="history-tab"
                  onClick={() => setActiveSheet({ type: 'history' })}
                >
                  <i
                    className="ico"
                    aria-hidden="true"
                    style={HISTORY_ICON_STYLE}
                  />
                  <span>السجل</span>
                </button>
              </nav>

              <CrashScene
                phase={phase}
                countdownSeconds={countdownSeconds}
                flightStartTime={flightStartTime}
                crashedMultiplier={crashedMultiplier}
                flightCrashedSec={flightCrashedSec}
                flightGrowthK={FLIGHT_GROWTH_K}
                resultBanner={resultBanner}
              />

              <div
                className={`bet-stack ${
                  isRoundTransition ? 'is-round-transition' : ''
                }`}
              >
                {betNotice && (
                  <div
                    key={betNotice.id}
                    className={`bet-notice ${
                      betNotice.type === 'error' ? 'is-error' : ''
                    }`}
                  >
                    {betNotice.text}
                  </div>
                )}

                <BetPanel
                  slot={slots[0]}
                  phase={phase}
                  onChangeInput={handleChangeInput}
                  onPickPreset={handlePickPreset}
                  onClearInput={handleClearInput}
                  onAction={handleAction}
                  onOpenAuto={(id) => setActiveSheet({ type: 'auto', slotId: id })}
                />

                <BetPanel
                  slot={slots[1]}
                  phase={phase}
                  onChangeInput={handleChangeInput}
                  onPickPreset={handlePickPreset}
                  onClearInput={handleClearInput}
                  onAction={handleAction}
                  onOpenAuto={(id) => setActiveSheet({ type: 'auto', slotId: id })}
                />
              </div>

              <section className="stats-row">
                <div>
                  <span>عدد الرهانات</span>
                  <b>
                    {displayBetsCount}{' '}
                    <i
                      className="ico"
                      aria-hidden="true"
                      style={STATS_BETS_ICON_STYLE}
                    />
                  </b>
                </div>
                <div>
                  <span>مجموع الرهانات</span>
                  <b>
                    {displayTotalPool}{' '}
                    <i
                      className="ico"
                      aria-hidden="true"
                      style={STATS_TOTAL_ICON_STYLE}
                    />
                  </b>
                  <strong>EGP</strong>
                </div>
                <div>
                  <span>مجموع الربح</span>
                  <b>
                    {displayTotalProfit}{' '}
                    <i
                      className="ico"
                      aria-hidden="true"
                      style={STATS_PROFIT_ICON_STYLE}
                    />
                  </b>
                  <strong>EGP</strong>
                </div>
              </section>

              <section className="bets-list" aria-label="قائمة الرهانات">
                <div className="list-head">
                  <span>اسم المستخدم</span>
                  <span>الفرص</span>
                  <span>الرهان</span>
                  <span>الأرباح</span>
                </div>

                {combinedRows.map((row) => (
                  <div
                    key={row.id}
                    className={`bet-row ${
                      row.status === 'win'
                        ? 'is-win'
                        : row.status === 'loss'
                        ? 'is-loss'
                        : ''
                    } ${row.isMe ? 'is-me' : ''}`}
                  >
                    <span>{row.username}</span>
                    <span>
                      x
                      {row.cashedOutAt !== null
                        ? row.cashedOutAt.toFixed(2)
                        : '0'}
                    </span>
                    <span>EGP {Number(row.stake.toFixed(2))}</span>
                    <span>
                      EGP {row.cashedOutAt !== null ? Number(row.payout.toFixed(2)) : 0}
                    </span>
                  </div>
                ))}
              </section>
            </div>
          </div>
        </main>
      </div>

      <CrashModals
        sheet={activeSheet}
        onClose={() => setActiveSheet(null)}
        historyRounds={historyRounds}
        currentSlotAuto={activeAutoSlot?.autoConfig}
        currentSlotInput={activeAutoSlot?.inputValue}
        onSaveAutoPlay={handleSaveAutoPlay}
        onDisableAutoPlay={handleDisableAutoPlay}
        balance={balance}
        onDeposit={handleDeposit}
        notifications={notifications}
      />
    </div>
  );
}

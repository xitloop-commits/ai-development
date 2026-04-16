import { useMemo, useState } from 'react';
import TradingDesk, { type ResolvedInstrument } from '@/components/TradingDesk';
import {
  StaticCapitalProvider,
  type CapitalContextValue,
  type CapitalState,
  type DayRecord,
} from '@/contexts/CapitalContext';

type Workspace = 'live' | 'paper_manual' | 'paper';

type MockTrade = {
  id: string;
  instrument: string;
  type: string;
  strike: number | null;
  expiry?: string | null;
  entryPrice: number;
  exitPrice: number | null;
  ltp: number;
  qty: number;
  capitalPercent: number;
  pnl: number;
  unrealizedPnl: number;
  charges: number;
  chargesBreakdown: Array<{ name: string; amount: number }>;
  status: string;
  targetPrice: number | null;
  stopLossPrice: number | null;
  openedAt: number;
  closedAt: number | null;
};

type MockDayRecord = DayRecord & {
  trades: MockTrade[];
};

type WorkspaceData = {
  capital: CapitalState;
  allDays: MockDayRecord[];
};

const RESOLVED_INSTRUMENTS: ResolvedInstrument[] = [
  { name: 'NIFTY_50', securityId: '13', exchange: 'IDX_I', mode: 'ticker' },
  { name: 'BANKNIFTY', securityId: '25', exchange: 'IDX_I', mode: 'ticker' },
  { name: 'CRUDEOIL', securityId: '654321', exchange: 'MCX_COMM', mode: 'ticker' },
  { name: 'NATURALGAS', securityId: '654322', exchange: 'MCX_COMM', mode: 'ticker' },
];

const NOW = new Date('2026-04-04T10:45:00+05:30').getTime();

function buildWorkspaceData(): Record<Workspace, WorkspaceData> {
  const liveDays: MockDayRecord[] = [
    {
      dayIndex: 1,
      date: '28-Mar',
      tradeCapital: 75000,
      targetPercent: 5,
      targetAmount: 3750,
      projCapital: 78750,
      originalProjCapital: 78750,
      actualCapital: 79560,
      deviation: 810,
      totalPnl: 4680,
      totalCharges: 120,
      totalQty: 18,
      instruments: ['NIFTY 50', 'BANK NIFTY'],
      trades: [],
      status: 'COMPLETED',
      rating: 'trophy',
      openedAt: NOW - 7 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 2,
      date: '29-Mar',
      tradeCapital: 78510,
      targetPercent: 5,
      targetAmount: 3926,
      projCapital: 82436,
      originalProjCapital: 82687,
      actualCapital: 83790,
      deviation: 1103,
      totalPnl: 7040,
      totalCharges: 150,
      totalQty: 22,
      instruments: ['CRUDE OIL'],
      trades: [],
      status: 'COMPLETED',
      rating: 'double_trophy',
      openedAt: NOW - 6 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 3,
      date: '30-Mar',
      tradeCapital: 83790,
      targetPercent: 5,
      targetAmount: 4190,
      projCapital: 87980,
      originalProjCapital: 86821,
      actualCapital: 87980,
      deviation: 1159,
      totalPnl: 4190,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'GIFT',
      rating: 'gift',
      openedAt: NOW - 5 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 4,
      date: '31-Mar',
      tradeCapital: 86932,
      targetPercent: 5,
      targetAmount: 4347,
      projCapital: 91279,
      originalProjCapital: 91162,
      actualCapital: 89840,
      deviation: -1322,
      totalPnl: 3040,
      totalCharges: 210,
      totalQty: 16,
      instruments: ['NATURAL GAS', 'CRUDE OIL'],
      trades: [],
      status: 'COMPLETED',
      rating: 'star',
      openedAt: NOW - 4 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 5,
      date: '01-Apr',
      tradeCapital: 89212,
      targetPercent: 5,
      targetAmount: 4461,
      projCapital: 93673,
      originalProjCapital: 95720,
      actualCapital: 96430,
      deviation: 710,
      totalPnl: 7440,
      totalCharges: 180,
      totalQty: 19,
      instruments: ['BANK NIFTY'],
      trades: [],
      status: 'COMPLETED',
      rating: 'double_trophy',
      openedAt: NOW - 3 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 6,
      date: '02-Apr',
      tradeCapital: 94882,
      targetPercent: 5,
      targetAmount: 4744,
      projCapital: 99626,
      originalProjCapital: 100506,
      actualCapital: 100910,
      deviation: 404,
      totalPnl: 6210,
      totalCharges: 165,
      totalQty: 14,
      instruments: ['NIFTY 50', 'CRUDE OIL'],
      trades: [],
      status: 'COMPLETED',
      rating: 'trophy',
      openedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 7,
      date: '04-Apr',
      tradeCapital: 100120,
      targetPercent: 5,
      targetAmount: 5006,
      projCapital: 105126,
      originalProjCapital: 105531,
      actualCapital: 103760,
      deviation: -1771,
      totalPnl: 3640,
      totalCharges: 420,
      totalQty: 47,
      instruments: ['NIFTY 50', 'BANK NIFTY', 'CRUDE OIL', 'NATURAL GAS'],
      trades: [
        {
          id: 'live-1',
          instrument: 'NIFTY 50',
          type: 'CALL_BUY',
          strike: 22450,
          entryPrice: 182.5,
          exitPrice: 214.4,
          ltp: 214.4,
          qty: 10,
          capitalPercent: 10,
          pnl: 319,
          unrealizedPnl: 0,
          charges: 42,
          chargesBreakdown: [{ name: 'Brokerage', amount: 42 }],
          status: 'CLOSED_TP',
          targetPrice: 212,
          stopLossPrice: 171,
          openedAt: NOW - 3 * 60 * 60 * 1000,
          closedAt: NOW - 2 * 60 * 60 * 1000,
        },
        {
          id: 'live-2',
          instrument: 'BANK NIFTY',
          type: 'PUT_BUY',
          strike: 48200,
          entryPrice: 141.2,
          exitPrice: 118.15,
          ltp: 118.15,
          qty: 8,
          capitalPercent: 10,
          pnl: -184.4,
          unrealizedPnl: 0,
          charges: 38,
          chargesBreakdown: [{ name: 'Brokerage', amount: 38 }],
          status: 'CLOSED_SL',
          targetPrice: 154,
          stopLossPrice: 121,
          openedAt: NOW - 2.5 * 60 * 60 * 1000,
          closedAt: NOW - 90 * 60 * 1000,
        },
        {
          id: 'live-3',
          instrument: 'CRUDE OIL',
          type: 'CALL_BUY',
          strike: 7420,
          entryPrice: 196.75,
          exitPrice: null,
          ltp: 221.35,
          qty: 12,
          capitalPercent: 15,
          pnl: 0,
          unrealizedPnl: 295.2,
          charges: 64,
          chargesBreakdown: [{ name: 'Brokerage', amount: 64 }],
          status: 'OPEN',
          targetPrice: 231,
          stopLossPrice: 184,
          openedAt: NOW - 75 * 60 * 1000,
          closedAt: null,
        },
        {
          id: 'live-4',
          instrument: 'NATURAL GAS',
          type: 'PUT_SELL',
          strike: 238,
          entryPrice: 21.6,
          exitPrice: null,
          ltp: 18.4,
          qty: 14,
          capitalPercent: 10,
          pnl: 0,
          unrealizedPnl: 44.8,
          charges: 51,
          chargesBreakdown: [{ name: 'Brokerage', amount: 51 }],
          status: 'OPEN',
          targetPrice: 17.8,
          stopLossPrice: 23.9,
          openedAt: NOW - 40 * 60 * 1000,
          closedAt: null,
        },
        {
          id: 'live-5',
          instrument: 'BANK NIFTY',
          type: 'CALL_BUY',
          strike: 48500,
          entryPrice: 96.25,
          exitPrice: null,
          ltp: 96.25,
          qty: 3,
          capitalPercent: 5,
          pnl: 0,
          unrealizedPnl: 0,
          charges: 0,
          chargesBreakdown: [],
          status: 'PENDING',
          targetPrice: 108,
          stopLossPrice: 89,
          openedAt: NOW - 8 * 60 * 1000,
          closedAt: null,
        },
      ],
      status: 'ACTIVE',
      rating: 'future',
      openedAt: NOW - 3 * 60 * 60 * 1000,
    },
    {
      dayIndex: 8,
      date: '07-Apr',
      tradeCapital: 102850,
      targetPercent: 5,
      targetAmount: 5143,
      projCapital: 107993,
      originalProjCapital: 110808,
      actualCapital: 0,
      deviation: 0,
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'FUTURE',
      rating: 'future',
    },
    {
      dayIndex: 9,
      date: '08-Apr',
      tradeCapital: 106707,
      targetPercent: 5,
      targetAmount: 5335,
      projCapital: 112042,
      originalProjCapital: 116348,
      actualCapital: 0,
      deviation: 0,
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'FUTURE',
      rating: 'future',
    },
    {
      dayIndex: 10,
      date: '09-Apr',
      tradeCapital: 110708,
      targetPercent: 5,
      targetAmount: 5535,
      projCapital: 116243,
      originalProjCapital: 122165,
      actualCapital: 0,
      deviation: 0,
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'FUTURE',
      rating: 'future',
    },
    {
      dayIndex: 250,
      date: '31-Mar-27',
      tradeCapital: 14652320,
      targetPercent: 5,
      targetAmount: 732616,
      projCapital: 15384936,
      originalProjCapital: 15723309,
      actualCapital: 0,
      deviation: 0,
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'FUTURE',
      rating: 'finish',
    },
  ];

  const liveCapital: CapitalState = {
    tradingPool: 100120,
    reservePool: 33480,
    currentDayIndex: 7,
    targetPercent: 5,
    availableCapital: 78450,
    netWorth: 133600,
    cumulativePnl: 32540,
    cumulativeCharges: 1245,
    todayPnl: 3640,
    todayTarget: 5006,
    initialFunding: 100000,
    openPositionMargin: 21670,
    quarterlyProjection: { quarterLabel: 'Q1 FY27', projectedCapital: 15384936 },
    allQuarterlyProjections: [],
  };

  const paperDays: MockDayRecord[] = [
    {
      dayIndex: 1,
      date: '02-Apr',
      tradeCapital: 75000,
      targetPercent: 5,
      targetAmount: 3750,
      projCapital: 78750,
      originalProjCapital: 78750,
      actualCapital: 79140,
      deviation: 390,
      totalPnl: 4260,
      totalCharges: 90,
      totalQty: 11,
      instruments: ['NIFTY 50'],
      trades: [],
      status: 'COMPLETED',
      rating: 'trophy',
      openedAt: NOW - 2 * 24 * 60 * 60 * 1000,
    },
    {
      dayIndex: 2,
      date: '04-Apr',
      tradeCapital: 78195,
      targetPercent: 5,
      targetAmount: 3910,
      projCapital: 82105,
      originalProjCapital: 82687,
      actualCapital: 80680,
      deviation: -2007,
      totalPnl: 2485,
      totalCharges: 75,
      totalQty: 9,
      instruments: ['BANK NIFTY', 'CRUDE OIL'],
      trades: [
        {
          id: 'paper-1',
          instrument: 'BANK NIFTY',
          type: 'PUT_BUY',
          strike: 48100,
          entryPrice: 126.3,
          exitPrice: null,
          ltp: 135.8,
          qty: 6,
          capitalPercent: 10,
          pnl: 0,
          unrealizedPnl: 57,
          charges: 24,
          chargesBreakdown: [{ name: 'Brokerage', amount: 24 }],
          status: 'OPEN',
          targetPrice: 142,
          stopLossPrice: 118,
          openedAt: NOW - 55 * 60 * 1000,
          closedAt: null,
        },
        {
          id: 'paper-2',
          instrument: 'CRUDE OIL',
          type: 'CALL_BUY',
          strike: 7440,
          entryPrice: 188.4,
          exitPrice: 201.15,
          ltp: 201.15,
          qty: 5,
          capitalPercent: 8,
          pnl: 63.75,
          unrealizedPnl: 0,
          charges: 18,
          chargesBreakdown: [{ name: 'Brokerage', amount: 18 }],
          status: 'CLOSED_PARTIAL',
          targetPrice: 205,
          stopLossPrice: 180,
          openedAt: NOW - 80 * 60 * 1000,
          closedAt: NOW - 20 * 60 * 1000,
        },
      ],
      status: 'ACTIVE',
      rating: 'future',
      openedAt: NOW - 90 * 60 * 1000,
    },
    {
      dayIndex: 3,
      date: '07-Apr',
      tradeCapital: 80059,
      targetPercent: 5,
      targetAmount: 4003,
      projCapital: 84062,
      originalProjCapital: 86821,
      actualCapital: 0,
      deviation: 0,
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'FUTURE',
      rating: 'future',
    },
    {
      dayIndex: 250,
      date: '31-Mar-27',
      tradeCapital: 12382420,
      targetPercent: 5,
      targetAmount: 619121,
      projCapital: 13001541,
      originalProjCapital: 13800930,
      actualCapital: 0,
      deviation: 0,
      totalPnl: 0,
      totalCharges: 0,
      totalQty: 0,
      instruments: [],
      trades: [],
      status: 'FUTURE',
      rating: 'finish',
    },
  ];

  const paperCapital: CapitalState = {
    tradingPool: 78195,
    reservePool: 26420,
    currentDayIndex: 2,
    targetPercent: 5,
    availableCapital: 69240,
    netWorth: 104615,
    cumulativePnl: 6745,
    cumulativeCharges: 165,
    todayPnl: 2485,
    todayTarget: 3910,
    initialFunding: 100000,
    openPositionMargin: 8955,
    quarterlyProjection: { quarterLabel: 'Q1 FY27', projectedCapital: 13001541 },
    allQuarterlyProjections: [],
  };

  const paperManualCapital: CapitalState = {
    ...liveCapital,
    todayPnl: 1265,
    availableCapital: 84290,
    openPositionMargin: 15830,
  };

  const paperManualDays: MockDayRecord[] = liveDays.map((day) => ({
    ...day,
    trades: day.trades.map((trade) => ({ ...trade })),
  }));

  return {
    live: { capital: liveCapital, allDays: liveDays },
    paper_manual: { capital: paperManualCapital, allDays: paperManualDays },
    paper: { capital: paperCapital, allDays: paperDays },
  };
}

export default function TradingDeskMockupPage() {
  const [workspace, setWorkspace] = useState<Workspace>('live');
  const workspaceData = useMemo(() => buildWorkspaceData(), []);
  const active = workspaceData[workspace];

  const providerValue = useMemo<CapitalContextValue>(() => {
    return {
      workspace,
      setWorkspace,
      capital: active.capital,
      capitalLoading: false,
      capitalReady: true,
      allDays: active.allDays,
      currentDay: active.allDays.find((day) => day.dayIndex === active.capital.currentDayIndex) ?? null,
      allDaysLoading: false,
      stateData: active.capital,
      allDaysData: {
        pastDays: active.allDays.filter((day) => day.dayIndex < active.capital.currentDayIndex),
        currentDay: active.allDays.find((day) => day.dayIndex === active.capital.currentDayIndex) ?? null,
        futureDays: active.allDays.filter((day) => day.dayIndex > active.capital.currentDayIndex),
      },
      inject: () => {},
      injectPending: false,
      placeTrade: () => {},
      placeTradePending: false,
      exitTrade: () => {},
      exitTradePending: false,
      updateLtp: () => {},
      syncDailyTarget: () => {},
      syncDailyTargetPending: false,
      resetCapital: () => {},
      resetCapitalPending: false,
      refetchAll: () => {},
    };
  }, [active, workspace]);

  return (
    <StaticCapitalProvider value={providerValue}>
      <div className="min-h-screen bg-background px-6 py-8">
        <div className="mx-auto max-w-[1800px]">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-[0.625rem] uppercase tracking-[0.3em] text-muted-foreground">Generated Mockup</p>
              <h1 className="font-mono text-2xl font-bold text-foreground">Trading Desk Current Component</h1>
            </div>
            <p className="max-w-xl text-right text-sm text-muted-foreground">
              Standalone mockup view rendered from the current React component with static capital and trade data.
            </p>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_30px_90px_rgba(0,0,0,0.35)]">
            <TradingDesk resolvedInstruments={RESOLVED_INSTRUMENTS} liveTicksEnabled={false} />
          </div>
        </div>
      </div>
    </StaticCapitalProvider>
  );
}

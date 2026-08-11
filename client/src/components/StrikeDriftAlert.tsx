/**
 * StrikeDriftAlert — T161. When the market walks ≥3 strikes away from an
 * instrument's session-locked strike, raise a persistent bottom-center toast
 * with an "OK — re-lock" action that recomputes the lock from the CURRENT
 * ATM (∓ configured offset). One alert per lock instance per instrument.
 */
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { useInstrumentLiveState } from '@/hooks/useInstrumentLiveState';

const INSTRUMENTS = ['nifty50', 'banknifty', 'crudeoil', 'naturalgas'];
const DRIFT_ALERT_STEPS = 3;

interface Lock {
  atmAtLock: number;
  offset: number;
  lockedAt: number;
  ce: { strike: number };
  pe: { strike: number };
}

export function StrikeDriftAlert() {
  const lockState = trpc.trading.strikeLockState.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const relock = trpc.trading.strikeRelock.useMutation({ onSuccess: () => lockState.refetch() });
  const anyLockOn = !!(lockState.data?.config?.paperEnabled || lockState.data?.config?.liveEnabled);
  if (!anyLockOn) return null;
  return (
    <>
      {INSTRUMENTS.map((inst) => (
        <DriftWatch
          key={inst}
          inst={inst}
          lock={(lockState.data?.locks?.[inst] ?? null) as Lock | null}
          onRelock={() => relock.mutate({ instrument: inst, force: true })}
        />
      ))}
    </>
  );
}

function DriftWatch({ inst, lock, onRelock }: {
  inst: string;
  lock: Lock | null;
  onRelock: () => void;
}) {
  const state = useInstrumentLiveState<{ live?: { atm_strike?: number | null }; signal?: { atm_strike?: number | null } }>(inst);
  const atm = state?.live?.atm_strike ?? state?.signal?.atm_strike ?? null;
  const warnedFor = useRef<number | null>(null); // lockedAt we already alerted on

  useEffect(() => {
    if (!lock || atm == null) return;
    // Strike step recovered from the lock itself (works for any instrument).
    const step = lock.offset > 0 ? Math.abs(lock.atmAtLock - lock.ce.strike) / lock.offset : 0;
    if (!(step > 0)) return;
    const drift = Math.round(Math.abs(atm - lock.atmAtLock) / step);
    if (drift >= DRIFT_ALERT_STEPS && warnedFor.current !== lock.lockedAt) {
      warnedFor.current = lock.lockedAt;
      toast(
        `${inst.toUpperCase()} has drifted ${drift} strikes from the locked strike — re-lock?`,
        {
          id: `strike-drift-${inst}`,
          duration: Infinity, // stays until acted on or dismissed
          position: 'bottom-center',
          action: { label: 'OK — re-lock', onClick: onRelock },
        },
      );
    }
  }, [lock, atm, onRelock]);

  return null;
}

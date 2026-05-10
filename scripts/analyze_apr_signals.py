"""Apr signal analysis — keep only signals that 'stood' for >=60s before being overridden."""
import json, glob, re, os
from datetime import datetime
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

filtered_files = sorted(glob.glob('logs/signals/*/2026-04-*_filtered_signals.log'))

real = []
for path in filtered_files:
    norm = path.replace(os.sep, '/')
    m = re.search(r'logs/signals/([^/]+)/', norm)
    inst = m.group(1) if m else '?'
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: d = json.loads(line)
            except: continue
            if str(d.get('model_version', '')).startswith('smoke'): continue
            if 'action' not in d: continue
            d['_inst'] = inst
            d['_dt'] = datetime.fromisoformat(d['timestamp_ist'])
            real.append(d)

# Sort per instrument and keep signals where next signal (same instrument) is >=60s later
real.sort(key=lambda d: (d['_inst'], d['_dt']))
by_inst = defaultdict(list)
for d in real: by_inst[d['_inst']].append(d)

valid = []
for inst, sigs in by_inst.items():
    for i, s in enumerate(sigs):
        if i + 1 < len(sigs):
            gap = (sigs[i+1]['_dt'] - s['_dt']).total_seconds()
        else:
            gap = float('inf')
        if gap >= 60:
            s['_gap_to_next'] = gap
            valid.append(s)

print(f'Total raw filter passes: {len(real)}')
print(f'Signals that stood >=60s before being overridden: {len(valid)}')
by2 = defaultdict(int)
for d in valid: by2[d['_inst']] += 1
for k, v in sorted(by2.items()): print(f'  {k}: {v}')

# Forward-walk simulator
raw_cache = {}
def load_raw(inst, date_str):
    path = f'logs/signals/{inst}/{date_str}_signals.log'
    if not os.path.exists(path): return []
    out = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try: r = json.loads(line)
            except: continue
            try: r['_dt'] = datetime.fromisoformat(r['timestamp_ist'])
            except: continue
            out.append(r)
    return out

def get_raw(inst, date_str):
    key = (inst, date_str)
    if key not in raw_cache: raw_cache[key] = load_raw(inst, date_str)
    return raw_cache[key]

def simulate(sig, horizon_sec=300):
    inst = sig['_inst']
    date_str = sig['_dt'].date().isoformat()
    raw = get_raw(inst, date_str)
    if not raw: return None
    t0 = sig['_dt']
    action = sig['action']
    entry, tp, sl = sig['entry'], sig['tp'], sig['sl']
    long_side = action.startswith('LONG')
    field = 'atm_ce_ltp' if action.endswith('CE') else 'atm_pe_ltp'
    entry_strike = sig.get('atm_strike')
    final_px = None; outcome = 'TIMEOUT'; t_exit = None; strike_rolled = False
    for r in raw:
        if r['_dt'] < t0: continue
        dt = (r['_dt'] - t0).total_seconds()
        if dt > horizon_sec: break
        if entry_strike and r.get('atm_strike') and r['atm_strike'] != entry_strike:
            strike_rolled = True
            break  # stop walk on strike change — comparison invalid past this point
        px = r.get(field)
        if px is None: continue
        final_px = px; t_exit = r['_dt']
        if long_side:
            if px >= tp: outcome = 'TP'; break
            if px <= sl: outcome = 'SL'; break
        else:
            if px <= tp: outcome = 'TP'; break
            if px >= sl: outcome = 'SL'; break
    if final_px is None and strike_rolled:
        return {'outcome': 'STRIKE_ROLL', 'pnl_pct': None, 't_exit_sec': None}
    if final_px is None: return None
    if long_side: pnl_pct = (final_px - entry) / entry * 100
    else: pnl_pct = (entry - final_px) / entry * 100
    if strike_rolled and outcome == 'TIMEOUT':
        outcome = 'STRIKE_ROLL_PARTIAL'
    return {'outcome': outcome, 'final_px': final_px, 'pnl_pct': pnl_pct,
            't_exit_sec': (t_exit - t0).total_seconds() if t_exit else None,
            'strike_rolled': strike_rolled}

print('\n--- Valid (stood >=60s) signals + 5-min outcome with strike-roll detection ---')
hdr = f"{'inst':10} {'time':19} {'action':9} {'score':>5} {'rr':>5} {'entry':>8} {'gap_next':>8}  {'outcome':18} {'exit_s':>6} {'pnl%':>7}"
print(hdr)

stats = defaultdict(lambda: {'n':0, 'pnl':0.0, 'tp':0, 'sl':0, 'to':0, 'roll':0})
total = {'n':0, 'pnl':0.0, 'tp':0, 'sl':0, 'to':0, 'roll':0}

for d in valid:
    sim = simulate(d)
    inst = d['_inst']
    gap = d['_gap_to_next']
    gap_str = f'{gap:.0f}s' if gap != float('inf') else 'last'
    if sim is None:
        print(f"{inst:10} {d['timestamp_ist'][:19]} {d['action']:9} {d.get('score','?'):>5} {float(d.get('rr',0)):>5.2f} {d['entry']:>8} {gap_str:>8}  NODATA")
        continue
    if sim['outcome'] == 'STRIKE_ROLL':
        stats[inst]['roll'] += 1; total['roll'] += 1
        print(f"{inst:10} {d['timestamp_ist'][:19]} {d['action']:9} {d.get('score','?'):>5} {float(d.get('rr',0)):>5.2f} {d['entry']:>8} {gap_str:>8}  {sim['outcome']:18}")
        continue
    pnl = sim['pnl_pct']
    stats[inst]['n'] += 1; stats[inst]['pnl'] += pnl
    total['n'] += 1; total['pnl'] += pnl
    if sim['outcome'].startswith('TP'): stats[inst]['tp'] += 1; total['tp'] += 1
    elif sim['outcome'].startswith('SL'): stats[inst]['sl'] += 1; total['sl'] += 1
    else: stats[inst]['to'] += 1; total['to'] += 1
    print(f"{inst:10} {d['timestamp_ist'][:19]} {d['action']:9} {d.get('score','?'):>5} {float(d.get('rr',0)):>5.2f} {d['entry']:>8} {gap_str:>8}  {sim['outcome']:18} {sim['t_exit_sec']:>6.0f} {pnl:>+7.2f}")

print(f'\n=== Summary (excluding STRIKE_ROLL skips) ===')
print(f"{'inst':11} {'n':>3} {'TP':>3} {'SL':>3} {'TO':>3} {'roll':>4}  {'total_pnl%':>10} {'avg_pnl%':>9}")
for inst in sorted(stats):
    s = stats[inst]; n = s['n']
    avg = s['pnl']/n if n else 0
    print(f"{inst:11} {n:>3} {s['tp']:>3} {s['sl']:>3} {s['to']:>3} {s['roll']:>4}  {s['pnl']:>+10.2f} {avg:>+9.2f}")
n = total['n']; avg = total['pnl']/n if n else 0
print(f"{'TOTAL':11} {n:>3} {total['tp']:>3} {total['sl']:>3} {total['to']:>3} {total['roll']:>4}  {total['pnl']:>+10.2f} {avg:>+9.2f}")
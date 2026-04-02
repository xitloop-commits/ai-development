/**
 * Quick test: verify MockAdapter → tickBus → tick flow works
 */
import { MockAdapter } from './server/broker/adapters/mock/index.js';
import { tickBus } from './server/broker/tickBus.js';

async function main() {
  console.log('1. Creating MockAdapter...');
  const adapter = new MockAdapter();

  console.log('2. Connecting...');
  await adapter.connect();
  console.log('   Connected:', adapter.isConnected());

  console.log('3. Setting up tickBus listener...');
  let tickCount = 0;
  tickBus.on('tick', (tick) => {
    tickCount++;
    if (tickCount <= 3) {
      console.log(`   Tick #${tickCount}: ${tick.exchange}:${tick.securityId} LTP=${tick.ltp}`);
    }
  });

  console.log('4. Subscribing to instruments...');
  adapter.subscribeLTP(
    [
      { securityId: 'NIFTY_50', exchange: 'NSE_FNO' as any, mode: 'full' as any },
      { securityId: 'BANKNIFTY', exchange: 'NSE_FNO' as any, mode: 'full' as any },
    ],
    (tick) => {
      tickBus.emitTick(tick);
    }
  );

  console.log('5. Waiting 5 seconds for ticks...');
  await new Promise((resolve) => setTimeout(resolve, 5000));

  console.log(`\nResult: Received ${tickCount} ticks in 5 seconds`);
  
  adapter.disconnect();
  process.exit(0);
}

main().catch(console.error);

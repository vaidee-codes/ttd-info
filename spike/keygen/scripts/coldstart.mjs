#!/usr/bin/env node
// Measures cold vs warm latency: idles past Vercel's 5-minute scale-in, then probes.
//   node coldstart.mjs https://ttd-keygen-spike.vercel.app [rounds=4] [idleMinutes=7]
const [base, rounds = '4', idle = '7'] = process.argv.slice(2);
if (!base) { console.error('usage: coldstart.mjs <base> [rounds] [idleMinutes]'); process.exit(2); }
const url = base.replace(/\/$/, '') + '/v1/ping';

async function probe() {
  const t0 = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(90000) });
    return { status: r.status, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: 0, ms: Math.round(performance.now() - t0), error: e.name };
  }
}

const out = [];
for (let i = 0; i < Number(rounds); i++) {
  const cold = await probe();
  const warm = await probe();
  out.push({ round: i + 1, at: new Date().toISOString(), cold, warm });
  console.log(JSON.stringify(out.at(-1)));
  if (i < Number(rounds) - 1) await new Promise((r) => setTimeout(r, Number(idle) * 60e3));
}
const colds = out.map((o) => o.cold.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ summary: { cold_min_ms: colds[0], cold_max_ms: colds.at(-1), cold_median_ms: colds[Math.floor(colds.length / 2)] } }));

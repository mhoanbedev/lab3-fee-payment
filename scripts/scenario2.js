// Tình huống 2 — Ngân hàng phản hồi rất chậm (DELAY_MS=5000).
const { sleep, startBank, startFee, stopAll, pay, fees, check, header, finish, countBy } = require('./lib');

(async () => {
  header('TÌNH HUỐNG 2 — Ngân hàng chậm 5 giây');
  await startBank({ DELAY_MS: '5000' });
  await startFee();

  const one = await pay(1, 100000);
  console.log(`  Một thanh toán: ${one.status} trong ${one.ms}ms`, one.body);
  check('Thanh toán trả 504 + status PENDING', one.status === 504 && one.body.status === 'PENDING', `${one.status} ${one.body.status}`);
  check('Thời gian trả lời ≤ 4,5 giây', one.ms <= 4500, `${one.ms}ms`);

  // 20 thanh toán cùng lúc; trong lúc chúng đang chờ thì đo GET công nợ nhiều lần.
  const t0 = Date.now();
  const burst = Promise.all(Array.from({ length: 20 }, () => pay(1, 100000)));
  const feeTimes = [];
  for (const at of [100, 500, 1000, 2000, 3000, 3800]) {
    await sleep(Math.max(0, at - (Date.now() - t0)));
    const f = await fees(1);
    feeTimes.push(f.ms);
  }
  const results = await burst;
  const maxPayMs = Math.max(...results.map((r) => r.ms));
  console.log('  20 thanh toán song song:', countBy(results, (r) => `${r.status} ${r.body.status}`), `chậm nhất ${maxPayMs}ms`);
  console.log(`  GET công nợ trong lúc chờ (ms): ${feeTimes.join(', ')}`);
  check('20 thanh toán đều trả trong ≤ 4,5 giây', maxPayMs <= 4500, `${maxPayMs}ms`);
  check('GET công nợ < 300ms khi 20 thanh toán đang chờ', Math.max(...feeTimes) < 300, `max ${Math.max(...feeTimes)}ms`);

  await finish();
})().catch(async (e) => {
  console.error(e);
  await stopAll();
  process.exit(1);
});

// Tình huống 3 — Duy trì kết nối: 200 thanh toán, 10 cùng lúc, 1.000đ mỗi lần.
const { sleep, startBank, startFee, stopAll, pay, bankStats, pool, check, header, finish, countBy } = require('./lib');

(async () => {
  header('TÌNH HUỐNG 3 — Keep-alive');
  await startBank();
  await startFee();

  const before = await bankStats();
  const t0 = performance.now();
  const results = await pool(200, 10, () => pay(1, 1000));
  const totalMs = Math.round(performance.now() - t0);
  const after = await bankStats();
  const ok = results.filter((r) => r.status === 201).length;
  const newConnections = after.connections - before.connections;
  console.log(`  200 thanh toán: ${totalMs}ms`, countBy(results, (r) => r.status), 'stats:', after);

  check('200/200 thanh toán thành công', ok === 200, `${ok}/200`);
  check('Số kết nối TCP ngân hàng phải mở ≤ 20', after.connections <= 20, `connections=${after.connections} (Fee Service mở ${newConnections}, còn lại là các lần đọc /stats của script)`);

  // Nhàn rỗi 6 giây: ngân hàng đã đóng các kết nối cũ (keepAliveTimeout 5s).
  console.log('  Nhàn rỗi 6 giây...');
  await sleep(6000);
  const later = [];
  for (let i = 0; i < 5; i++) later.push(await pay(1, 1000));
  console.log('  Sau khi nhàn rỗi:', later.map((r) => `${r.status}/${r.ms}ms`).join(', '), 'stats:', await bankStats());
  check('Sau 6 giây nhàn rỗi, 5 yêu cầu tiếp theo vẫn thành công', later.every((r) => r.status === 201));

  await finish();
})().catch(async (e) => {
  console.error(e);
  await stopAll();
  process.exit(1);
});

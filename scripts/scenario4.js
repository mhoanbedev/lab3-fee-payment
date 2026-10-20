// Tình huống 4 — (a) đứt kết nối sau khi trừ tiền, (b) lỗi 500 tạm thời, (c) bị từ chối 402.
const { sleep, startBank, startFee, stopAll, pay, fees, bankStats, feePayments, check, header, finish, countBy } = require('./lib');

const AMOUNT = 100000;
const INITIAL_DEBT = 50_000_000;

async function sixtyPayments() {
  const results = [];
  for (let i = 0; i < 60; i++) results.push(await pay(1, AMOUNT));
  return results;
}

async function caseA() {
  console.log('\n  (a) DROP_RATE=0.3 — ngân hàng trừ tiền xong rồi cắt kết nối');
  await startBank({ DROP_RATE: '0.3' });
  await startFee();
  const results = await sixtyPayments();
  const stats = await bankStats();
  const debt = (await fees(1)).body.debt;
  const list = await feePayments();
  const paid = results.filter((r) => r.status === 201).length;
  const failed = results.filter((r) => r.status !== 201);
  const maxMs = Math.max(...results.map((r) => r.ms));
  console.log('    Kết quả:', countBy(results, (r) => `${r.status} ${r.body.status}`), 'bank stats:', stats, `chậm nhất ${maxMs}ms`);
  console.log(`    Công nợ: ${INITIAL_DEBT} → ${debt} (giảm ${INITIAL_DEBT - debt}), tổng tiền lệnh PAID = ${list.paidAmount}`);

  check('(a) duplicates = 0', stats.duplicates === 0, `duplicates=${stats.duplicates}`);
  check('(a) ≥ 54/60 thanh toán thành công', paid >= 54, `${paid}/60`);
  check('(a) Lệnh không thành công trả 504 + PENDING', failed.every((r) => r.status === 504 && r.body.status === 'PENDING'), `${failed.length} lệnh`);
  check('(a) Công nợ chỉ giảm đúng tiền các lệnh PAID', INITIAL_DEBT - debt === list.paidAmount);
  check('(a) Mọi thanh toán ≤ 4,5 giây', maxMs <= 4500, `${maxMs}ms`);
  if (stats.charges !== list.summary.PAID) {
    console.log(`    Ngân hàng đã trừ ${stats.charges} lần nhưng chỉ ${list.summary.PAID || 0} lệnh PAID → chờ đối soát nền...`);
    await sleep(12000);
    const s2 = await bankStats();
    const l2 = await feePayments();
    console.log(`    Sau đối soát: charges=${s2.charges}, PAID=${l2.summary.PAID}, PENDING=${l2.summary.PENDING || 0}, duplicates=${s2.duplicates}`);
  } else {
    console.log(`    charges ở ngân hàng (${stats.charges}) = số lệnh PAID (${list.summary.PAID}) — khớp sổ.`);
  }
  await stopAll();
}

async function caseB() {
  console.log('\n  (b) FAIL_RATE=0.3 — ngân hàng trả 500 trước khi trừ tiền');
  await startBank({ FAIL_RATE: '0.3' });
  await startFee();
  const results = await sixtyPayments();
  const stats = await bankStats();
  const paid = results.filter((r) => r.status === 201).length;
  const maxMs = Math.max(...results.map((r) => r.ms));
  console.log('    Kết quả:', countBy(results, (r) => `${r.status} ${r.body.status}`), 'bank stats:', stats, `chậm nhất ${maxMs}ms`);
  check('(b) ≥ 54/60 thanh toán thành công', paid >= 54, `${paid}/60`);
  check('(b) Không trừ tiền hai lần (duplicates = 0)', stats.duplicates === 0);
  check('(b) charges ở ngân hàng = số lệnh PAID', stats.charges === paid, `charges=${stats.charges}, PAID=${paid}`);
  check('(b) Mọi thanh toán ≤ 4,5 giây', maxMs <= 4500, `${maxMs}ms`);
  await stopAll();
}

async function caseC() {
  console.log('\n  (c) Thanh toán 25.000.000đ — vượt hạn mức 20.000.000đ');
  await startBank();
  await startFee();
  const r = await pay(1, 25_000_000);
  const stats = await bankStats();
  console.log(`    ${r.status} trong ${r.ms}ms`, r.body, 'bank stats:', stats);
  check('(c) Trả 402', r.status === 402, `nhận ${r.status}`);
  check('(c) JSON có error, paymentId, status FAILED', !!r.body.error && !!r.body.paymentId && r.body.status === 'FAILED');
  check('(c) Ngân hàng chỉ nhận đúng 1 yêu cầu', stats.requests === 1, `requests=${stats.requests}`);
  await stopAll();
}

(async () => {
  header('TÌNH HUỐNG 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối');
  await caseA();
  await caseB();
  await caseC();
  await finish();
})().catch(async (e) => {
  console.error(e);
  await stopAll();
  process.exit(1);
});

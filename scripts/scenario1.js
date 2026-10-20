// Tình huống 1 — Ngân hàng không kết nối được, rồi hoạt động lại.
const { sleep, startBank, startFee, stopAll, pay, fees, check, header, finish } = require('./lib');

async function bankDownPhase(label) {
  const r = await pay(1, 100000);
  console.log(`  [${label}] POST thanh toán khi ngân hàng tắt: ${r.status} trong ${r.ms}ms`, r.body);
  const f = await fees(1);
  console.log(`  [${label}] GET công nợ: ${f.status} trong ${f.ms}ms`, f.body);
  return { r, f };
}

(async () => {
  header('TÌNH HUỐNG 1 — Ngân hàng tắt rồi bật lại');

  // 1a. Fee Service lên trước, ngân hàng chưa chạy.
  await startFee();
  const { r: down, f: feesDown } = await bankDownPhase('BANK_URL mặc định');
  check('Ngân hàng tắt: thanh toán trả 503', down.status === 503, `nhận ${down.status}`);
  check('JSON có error, paymentId, status', !!down.body.error && 'paymentId' in down.body && !!down.body.status);
  check('Trả lời trong < 1,5 giây', down.ms < 1500, `${down.ms}ms`);
  check('Fee Service không sập, GET công nợ 200 nhanh', feesDown.status === 200 && feesDown.ms < 300, `${feesDown.ms}ms`);
  check('Công nợ không đổi khi chưa trừ tiền', feesDown.body.debt === 50_000_000);

  // 1b. Ngân hàng lên sau — KHÔNG khởi động lại Fee Service.
  await startBank();
  await sleep(200);
  const up = await pay(1, 100000);
  console.log(`  Sau khi bật ngân hàng: ${up.status} trong ${up.ms}ms`, up.body);
  check('Ngân hàng chạy lại: trả 201 không cần restart Fee Service', up.status === 201, `nhận ${up.status}`);
  await stopAll();

  // 1c. BANK_URL trỏ tới cổng không có ai nghe.
  await startFee({ BANK_URL: 'http://localhost:4999' });
  const { r: other, f: feesOther } = await bankDownPhase('BANK_URL=http://localhost:4999');
  check('BANK_URL=:4999: vẫn trả 503 trong < 1,5 giây', other.status === 503 && other.ms < 1500, `${other.status} / ${other.ms}ms`);
  check('BANK_URL=:4999: GET công nợ vẫn 200', feesOther.status === 200);

  await finish();
})().catch(async (e) => {
  console.error(e);
  await stopAll();
  process.exit(1);
});

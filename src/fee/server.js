// Fee Service — cổng 4001. Hệ thống học phí của trường, gọi sang cổng ngân hàng.
// Chạy `node src/fee/server.js --naive` (hoặc FEE_MODE=naive) để có bản "trước khi sửa".
const express = require('express');
const crypto = require('crypto');
const { config, chargeResilient, chargeNaive } = require('./bank-client');

const PORT = Number(process.env.PORT || 4001);
const MODE = process.argv.includes('--naive') || process.env.FEE_MODE === 'naive' ? 'naive' : 'resilient';
const RECONCILE_INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 5000);
const RECONCILE_DEADLINE_MS = Number(process.env.RECONCILE_DEADLINE_MS || 15000);

// Mỗi lần khởi động có một BOOT_ID riêng để Idempotency-Key của P1 lần chạy này
// không đụng P1 của lần chạy trước (ngân hàng còn nhớ khóa cũ).
const BOOT_ID = crypto.randomUUID().slice(0, 8);

const students = new Map([
  ['1', { studentId: 1, debt: 50_000_000, reserved: 0 }],
  ['2', { studentId: 2, debt: 0, reserved: 0 }],
  ['3', { studentId: 3, debt: 3_200_000, reserved: 0 }],
]);
const payments = new Map();
let paymentSeq = 0;

const errorBody = (error, payment, status = payment ? payment.status : 'FAILED') => ({
  error,
  paymentId: payment ? payment.paymentId : null,
  status,
});

function settle(payment, student, result) {
  payment.attempts += result.attempts || 0;
  payment.updatedAt = new Date().toISOString();
  switch (result.outcome) {
    case 'PAID':
      // Công nợ CHỈ giảm khi ngân hàng đã xác nhận trừ tiền.
      student.debt -= payment.amount;
      student.reserved -= payment.amount;
      payment.status = 'PAID';
      payment.chargeId = result.charge.chargeId;
      return;
    case 'UNKNOWN':
      // Giữ tiền đã "đặt chỗ" để không cho thanh toán vượt công nợ khi kết quả chưa rõ.
      payment.status = 'PENDING';
      payment.error = result.error;
      return;
    default:
      student.reserved -= payment.amount;
      payment.status = 'FAILED';
      payment.error = result.error;
  }
}

function httpStatusFor(result) {
  switch (result.outcome) {
    case 'PAID':
      return 201;
    case 'REJECTED':
      return result.httpStatus; // giữ nguyên mã của ngân hàng, ví dụ 402
    case 'NOT_CHARGED':
      return 503;
    case 'UNKNOWN':
      return 504;
    case 'FAILED_5XX':
      return result.httpStatus;
    default:
      return 500; // chỉ bản naive rơi vào đây
  }
}

const app = express();
app.use(express.json());

app.get('/students/:id/fees', (req, res) => {
  const student = students.get(req.params.id);
  if (!student) return res.status(404).json({ error: 'Không tìm thấy sinh viên' });
  res.json({ studentId: student.studentId, debt: student.debt, pendingAmount: student.reserved });
});

app.post('/students/:id/payments', async (req, res) => {
  const student = students.get(req.params.id);
  if (!student) return res.status(404).json(errorBody('Không tìm thấy sinh viên', null));

  const amount = req.body && req.body.amount;
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json(errorBody('amount phải là số nguyên dương', null));
  }
  // Trừ cả phần đang chờ (reserved) để 2 thanh toán song song không cùng vượt công nợ.
  if (amount > student.debt - student.reserved) {
    return res.status(400).json(errorBody('Số tiền vượt quá công nợ còn lại', null));
  }

  student.reserved += amount;
  const paymentId = `P${++paymentSeq}`;
  const payment = {
    paymentId,
    studentId: student.studentId,
    amount,
    status: 'PROCESSING',
    idempotencyKey: `fee-${BOOT_ID}-${paymentId}`,
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  payments.set(paymentId, payment);

  try {
    const charge = MODE === 'naive' ? chargeNaive : chargeResilient;
    const result = await charge({ reference: paymentId, amount, idempotencyKey: payment.idempotencyKey });
    settle(payment, student, result);
    const status = httpStatusFor(result);
    console.log(`[fee] ${paymentId} ${amount}đ -> ${payment.status} (${status}, ${result.attempts} lần gọi)`);

    if (payment.status === 'PAID') {
      return res.status(201).json({
        paymentId,
        status: 'PAID',
        amount,
        chargeId: payment.chargeId,
        remainingDebt: student.debt,
      });
    }
    return res.status(status).json(errorBody(result.error, payment));
  } catch (err) {
    // Lỗi lập trình bất ngờ: không biết đã gửi ngân hàng chưa → để PENDING cho đối soát.
    payment.status = 'PENDING';
    payment.error = err.message;
    return res.status(500).json(errorBody(err.message, payment));
  }
});

app.get('/payments', (req, res) => {
  const list = [...payments.values()];
  const summary = list.reduce((acc, p) => ((acc[p.status] = (acc[p.status] || 0) + 1), acc), {});
  const paidAmount = list.filter((p) => p.status === 'PAID').reduce((s, p) => s + p.amount, 0);
  res.json({ mode: MODE, total: list.length, summary, paidAmount, payments: list });
});

app.get('/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(404).json(errorBody('Không tìm thấy lệnh thanh toán', null));
  res.json(payment);
});

// Đối soát nền: lệnh PENDING được gửi lại với CÙNG Idempotency-Key. Nếu ngân hàng
// đã trừ tiền thì trả lại giao dịch cũ (không trừ thêm) → lệnh thành PAID.
let reconciling = false;
async function reconcilePending() {
  if (reconciling || MODE === 'naive') return;
  reconciling = true;
  try {
    for (const payment of payments.values()) {
      if (payment.status !== 'PENDING') continue;
      const student = students.get(String(payment.studentId));
      const result = await chargeResilient(
        { reference: payment.paymentId, amount: payment.amount, idempotencyKey: payment.idempotencyKey },
        { deadlineMs: RECONCILE_DEADLINE_MS },
      );
      if (result.outcome === 'NOT_CHARGED' || result.outcome === 'UNKNOWN') continue; // để lượt sau
      settle(payment, student, result);
      console.log(`[fee] đối soát ${payment.paymentId} -> ${payment.status}`);
    }
  } finally {
    reconciling = false;
  }
}
setInterval(reconcilePending, RECONCILE_INTERVAL_MS).unref();

app.listen(PORT, () => {
  console.log(`[fee] listening on :${PORT} mode=${MODE} BANK_URL=${config.bankUrl} deadline=${config.deadlineMs}ms`);
});

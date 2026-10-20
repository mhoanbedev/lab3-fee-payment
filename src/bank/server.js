// Ngân hàng giả lập — cổng 4002.
// Hành vi lỗi đặt bằng biến môi trường (khởi động lại để áp dụng):
//   DELAY_MS   trễ thêm ngần ấy ms cho mỗi yêu cầu /charges
//   FAIL_RATE  (0–1) tỉ lệ trả 500 TRƯỚC khi trừ tiền
//   DROP_RATE  (0–1) tỉ lệ trừ tiền xong rồi cắt kết nối, không trả lời
const express = require('express');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 4002);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
const FAIL_RATE = Number(process.env.FAIL_RATE || 0);
const DROP_RATE = Number(process.env.DROP_RATE || 0);
const LIMIT = 20_000_000; // hạn mức mỗi giao dịch

const stats = { connections: 0, requests: 0, charges: 0, duplicates: 0 };
const charges = new Map(); // chargeId -> charge
const chargedReferences = new Map(); // reference -> số lần đã trừ tiền
// Idempotency-Key -> Promise<{ status, body }>. Lưu PROMISE chứ không lưu kết quả,
// để yêu cầu thứ hai cùng khóa đến khi yêu cầu đầu còn đang xử lý sẽ chờ chung,
// không trừ tiền thêm lần nữa.
const idempotency = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function processCharge(reference, amount) {
  if (typeof reference !== 'string' || reference.trim() === '') {
    return { status: 400, body: { error: 'reference là bắt buộc' } };
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    return { status: 400, body: { error: 'Số tiền không hợp lệ' } };
  }
  if (amount > LIMIT) {
    return { status: 402, body: { error: `Vượt hạn mức ${LIMIT.toLocaleString('vi-VN')}đ` } };
  }

  const times = chargedReferences.get(reference) || 0;
  if (times > 0) {
    stats.duplicates++;
    console.warn(`[bank] !!! TRỪ TIỀN TRÙNG cho reference=${reference} (lần ${times + 1})`);
  }
  chargedReferences.set(reference, times + 1);

  const charge = {
    chargeId: 'ch_' + crypto.randomUUID().slice(0, 8),
    reference,
    amount,
    createdAt: new Date().toISOString(),
  };
  charges.set(charge.chargeId, charge);
  stats.charges++;
  return { status: 201, body: charge };
}

const app = express();
app.use(express.json());

app.post('/charges', async (req, res) => {
  stats.requests++;
  if (DELAY_MS > 0) await sleep(DELAY_MS);

  // Lỗi tạm thời: xảy ra TRƯỚC khi trừ tiền, không ghi gì vào sổ idempotency.
  if (Math.random() < FAIL_RATE) {
    return res.status(500).json({ error: 'Lỗi tạm thời của ngân hàng' });
  }

  const { reference, amount } = req.body || {};
  const key = req.get('Idempotency-Key');
  let result;
  if (key) {
    if (!idempotency.has(key)) {
      idempotency.set(key, Promise.resolve(processCharge(reference, amount)));
    }
    result = await idempotency.get(key);
  } else {
    result = processCharge(reference, amount);
  }

  // Đứt kết nối sau khi đã trừ tiền: bên gọi không biết kết quả.
  if (result.status === 201 && Math.random() < DROP_RATE) {
    req.socket.destroy();
    return;
  }
  res.status(result.status).json(result.body);
});

app.get('/charges/:id', (req, res) => {
  const charge = charges.get(req.params.id);
  if (!charge) return res.status(404).json({ error: 'Không tìm thấy giao dịch' });
  res.json(charge);
});

app.get('/stats', (_req, res) => res.json(stats));

const server = app.listen(PORT, () => {
  console.log(
    `[bank] listening on :${PORT} DELAY_MS=${DELAY_MS} FAIL_RATE=${FAIL_RATE} DROP_RATE=${DROP_RATE} keepAliveTimeout=${server.keepAliveTimeout}ms`,
  );
});
// keepAliveTimeout giữ mặc định của Node.js (5000ms) — đề bài yêu cầu.
server.on('connection', (socket) => {
  stats.connections++;
  console.log(`[bank] kết nối TCP mới #${stats.connections} từ ${socket.remoteAddress}:${socket.remotePort}`);
});

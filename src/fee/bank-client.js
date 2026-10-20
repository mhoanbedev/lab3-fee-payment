// Client gọi cổng ngân hàng. Hai chế độ để đo "trước / sau khi sửa":
//
//  naive      — bản ngây thơ ban đầu: mỗi lời gọi mở kết nối TCP mới, không timeout,
//               không thử lại, không Idempotency-Key.
//  resilient  — bản đã sửa:
//    • Keep-alive agent: dùng lại kết nối TCP (tình huống 3). Socket rảnh tự đóng sau
//      FREE_SOCKET_TIMEOUT_MS < 5s của ngân hàng để không dùng phải socket ngân hàng đã đóng.
//    • Deadline tổng BANK_DEADLINE_MS cho cả mọi lần thử (tình huống 2, ≤ 4,5 s).
//    • Connect timeout ngắn + ngân sách CONNECT_BUDGET_MS: ngân hàng tắt thì báo 503 nhanh (TH1).
//    • Thử lại với CÙNG Idempotency-Key khi đứt kết nối / lỗi 5xx (tình huống 4a, 4b),
//      KHÔNG thử lại lỗi 4xx (tình huống 4c).
//    • Phân biệt "chắc chắn chưa gửi tới ngân hàng" (chưa từng kết nối được) với
//      "đã gửi nhưng không biết kết quả" (đã kết nối rồi đứt / hết giờ).
const http = require('http');
const https = require('https');

const env = (name, def) => Number(process.env[name] || def);
const config = {
  bankUrl: process.env.BANK_URL || 'http://localhost:4002',
  deadlineMs: env('BANK_DEADLINE_MS', 4000),
  connectTimeoutMs: env('BANK_CONNECT_TIMEOUT_MS', 500),
  connectBudgetMs: env('BANK_CONNECT_BUDGET_MS', 1000),
  maxAttempts: env('BANK_MAX_ATTEMPTS', 6),
  freeSocketTimeoutMs: env('BANK_FREE_SOCKET_TIMEOUT_MS', 4000),
};

const isHttps = config.bankUrl.startsWith('https:');
const transport = isHttps ? https : http;
const keepAliveAgent = new transport.Agent({
  keepAlive: true,
  maxSockets: 50,
  maxFreeSockets: 20,
  // Với agent keep-alive, `timeout` là thời gian socket được nằm rảnh trong pool
  // trước khi agent tự hủy — đặt nhỏ hơn keepAliveTimeout 5s của ngân hàng.
  timeout: config.freeSocketTimeoutMs,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Một lần gọi HTTP. Không bao giờ reject — trả về mô tả kết quả. */
function attempt({ path, payload, headers, timeoutMs, agent }) {
  return new Promise((resolve) => {
    let connected = false;
    let settled = false;
    const timers = [];
    const done = (result) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      resolve({ ...result, connected: result.connected ?? connected });
    };

    const req = transport.request(
      new URL(path, config.bankUrl),
      {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = { raw: data };
          }
          done({ kind: 'response', status: res.statusCode, body });
        });
        res.on('error', (err) => done({ kind: 'error', code: err.code || err.message, connected: true }));
      },
    );

    req.on('socket', (socket) => {
      if (socket.connecting) socket.once('connect', () => (connected = true));
      else connected = true; // socket tái sử dụng từ pool keep-alive
    });
    req.on('error', (err) => done({ kind: 'error', code: err.code || err.message }));

    if (timeoutMs > 0) {
      timers.push(
        setTimeout(() => {
          done({ kind: 'error', code: 'ETIMEDOUT', timedOut: true });
          req.destroy();
        }, timeoutMs),
      );
    }
    if (config.connectTimeoutMs > 0 && agent !== false) {
      timers.push(
        setTimeout(() => {
          if (connected) return;
          done({ kind: 'error', code: 'ECONNECT_TIMEOUT', connected: false });
          req.destroy();
        }, config.connectTimeoutMs),
      );
    }
    req.end(payload);
  });
}

// Kết quả chuẩn hóa trả cho Fee Service:
//   { outcome: 'PAID', charge }                  ngân hàng xác nhận đã trừ tiền
//   { outcome: 'REJECTED', httpStatus, error }   ngân hàng từ chối rõ ràng (4xx)
//   { outcome: 'NOT_CHARGED', error }            chắc chắn chưa trừ tiền
//   { outcome: 'UNKNOWN', error }                không biết đã trừ hay chưa
function classifyResponse(r) {
  if (r.status === 201) return { outcome: 'PAID', charge: r.body };
  if (r.status >= 400 && r.status < 500) {
    return { outcome: 'REJECTED', httpStatus: r.status, error: r.body.error || `Ngân hàng từ chối (${r.status})` };
  }
  return null; // 5xx → có thể thử lại
}

/** Bản đã sửa. `deadlineMs` cho phép bộ đối soát nền dùng hạn chót dài hơn. */
async function chargeResilient({ reference, amount, idempotencyKey }, { deadlineMs = config.deadlineMs } = {}) {
  const start = Date.now();
  const deadline = start + deadlineMs;
  const payload = JSON.stringify({ reference, amount });
  let maybeCharged = false; // đã từng gửi được yêu cầu tới ngân hàng mà không có câu trả lời rõ ràng
  let everConnected = false;
  let lastError = 'Không gọi được ngân hàng';
  let attempts = 0;

  while (attempts < config.maxAttempts) {
    const remaining = deadline - Date.now();
    if (remaining < 50) break;
    attempts++;
    const r = await attempt({
      path: '/charges',
      payload,
      headers: { 'Idempotency-Key': idempotencyKey },
      timeoutMs: remaining,
      agent: keepAliveAgent,
    });
    if (r.connected) everConnected = true;

    if (r.kind === 'response') {
      const final = classifyResponse(r);
      if (final) return { ...final, attempts };
      // 500/503: ngân hàng báo lỗi TRƯỚC khi trừ tiền → thử lại an toàn.
      // 502/504 (ví dụ từ proxy) thì không chắc → coi như có thể đã trừ.
      if (r.status === 502 || r.status === 504) maybeCharged = true;
      lastError = `Ngân hàng lỗi ${r.status}`;
    } else {
      lastError = r.code;
      if (r.connected) maybeCharged = true; // đã gửi đi rồi mới đứt / hết giờ
      if (r.timedOut) break; // đã dùng hết hạn chót
    }

    const backoff = Math.min(800, 100 * 2 ** (attempts - 1)) * (0.5 + Math.random() / 2);
    if (Date.now() + backoff >= deadline - 50) break;
    // Chưa từng kết nối được: ngân hàng không chạy → dừng trong ngân sách kết nối để trả 503 nhanh.
    if (!everConnected && Date.now() + backoff - start >= config.connectBudgetMs) break;
    await sleep(backoff);
  }

  return maybeCharged
    ? { outcome: 'UNKNOWN', error: `Không rõ kết quả trừ tiền (${lastError})`, attempts }
    : { outcome: 'NOT_CHARGED', error: `Không kết nối được tới ngân hàng (${lastError})`, attempts };
}

/** Bản ngây thơ — giữ lại để đo số liệu "trước khi sửa". */
async function chargeNaive({ reference, amount }) {
  const r = await attempt({
    path: '/charges',
    payload: JSON.stringify({ reference, amount }),
    headers: { Connection: 'close' },
    timeoutMs: 0,
    agent: false, // mỗi lời gọi một kết nối TCP mới
  });
  if (r.kind === 'response') {
    return classifyResponse(r) || { outcome: 'FAILED_5XX', httpStatus: r.status, error: r.body.error, attempts: 1 };
  }
  return { outcome: 'ERROR', error: r.code, attempts: 1 };
}

module.exports = { config, chargeResilient, chargeNaive };

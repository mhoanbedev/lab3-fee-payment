// Tiện ích dùng chung cho các script đo: bật/tắt service, gọi HTTP, đo thời gian, in checklist.
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const FEE = 'http://localhost:4001';
const BANK = 'http://localhost:4002';
const NAIVE = process.argv.includes('--naive');
const VERBOSE = process.argv.includes('--verbose');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = new Set();

/** Khởi động một service Node, chờ tới khi in "listening". */
function start(name, script, { env = {}, args = [] } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, script), ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(proc);
    const timer = setTimeout(() => reject(new Error(`${name} không khởi động được`)), 10000);
    const onData = (buf) => {
      const text = buf.toString();
      if (VERBOSE) process.stdout.write(`    ${text.replace(/\n(?=.)/g, '\n    ')}`);
      if (text.includes('listening')) {
        clearTimeout(timer);
        resolve({
          proc,
          stop: () => stop(proc),
        });
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (b) => process.stderr.write(`[${name} stderr] ${b}`));
    proc.on('exit', (code) => {
      running.delete(proc);
      if (code && code !== 0 && !proc.killedByUs) reject(new Error(`${name} thoát với mã ${code}`));
    });
  });
}

function stop(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null) return resolve();
    proc.killedByUs = true;
    proc.once('exit', () => resolve());
    proc.kill();
  });
}

async function stopAll() {
  await Promise.all([...running].map(stop));
}
process.on('exit', () => running.forEach((p) => p.kill()));
process.on('SIGINT', () => process.exit(1));

const startBank = (env = {}) => start('bank', 'src/bank/server.js', { env });
const startFee = (env = {}) => start('fee', 'src/fee/server.js', { env, args: NAIVE ? ['--naive'] : [] });

// Agent riêng cho script (đóng vai trình duyệt của sinh viên), không ảnh hưởng số đo ở ngân hàng.
// timeout < 5s: server Node đóng kết nối rảnh sau 5s, không hủy sớm thì dùng phải socket chết (ECONNRESET).
const clientAgent = new http.Agent({ keepAlive: true, maxSockets: 100, timeout: 4000 });

/** Gọi HTTP, trả { status, body, ms }. status = 0 nếu lỗi mạng. */
function call(method, url, body) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        agent: clientAgent,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, ms: Math.round(performance.now() - t0) });
        });
      },
    );
    req.on('error', (err) => resolve({ status: 0, body: { error: err.code || err.message }, ms: Math.round(performance.now() - t0) }));
    req.end(payload);
  });
}

const pay = (studentId, amount) => call('POST', `${FEE}/students/${studentId}/payments`, { amount });
const fees = (studentId) => call('GET', `${FEE}/students/${studentId}/fees`);
const bankStats = async () => (await call('GET', `${BANK}/stats`)).body;
const feePayments = async () => (await call('GET', `${FEE}/payments`)).body;

/** Chạy `tasks` với tối đa `concurrency` việc cùng lúc. */
async function pool(count, concurrency, task) {
  const results = new Array(count);
  let next = 0;
  async function worker() {
    while (next < count) {
      const i = next++;
      results[i] = await task(i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

const checks = [];
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`  ${ok ? '✔' : '✘'} ${label}${detail ? `  — ${detail}` : ''}`);
}

function header(title) {
  console.log(`\n=== ${title} ${NAIVE ? '[TRƯỚC KHI SỬA — naive]' : '[SAU KHI SỬA — resilient]'} ===`);
}

async function finish() {
  await stopAll();
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n  Kết quả: ${passed}/${checks.length} tiêu chí đạt\n`);
  process.exitCode = passed === checks.length ? 0 : 1;
}

const countBy = (arr, keyFn) => arr.reduce((acc, x) => ((acc[keyFn(x)] = (acc[keyFn(x)] || 0) + 1), acc), {});

module.exports = {
  FEE,
  BANK,
  NAIVE,
  sleep,
  startBank,
  startFee,
  stopAll,
  call,
  pay,
  fees,
  bankStats,
  feePayments,
  pool,
  check,
  header,
  finish,
  countBy,
};

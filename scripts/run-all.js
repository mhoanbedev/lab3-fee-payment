// Chạy cả 4 tình huống ở hai chế độ: trước khi sửa (--naive) và sau khi sửa.
const { spawnSync } = require('child_process');
const path = require('path');

const summary = [];
for (const mode of [['--naive'], []]) {
  for (const n of [1, 2, 3, 4]) {
    const r = spawnSync(process.execPath, [path.join(__dirname, `scenario${n}.js`), ...mode], { stdio: 'inherit' });
    summary.push(`TH${n} ${mode.length ? 'trước khi sửa' : 'sau khi sửa  '}: ${r.status === 0 ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
  }
}
console.log('\n===== TỔNG KẾT =====');
summary.forEach((line) => console.log(line));

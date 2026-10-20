# Lab 3 — Kết nối và duy trì kết nối giữa các service

Hệ thống thanh toán học phí: **Fee Service** (cổng 4001, hệ thống của trường) gọi **cổng ngân hàng giả lập** (cổng 4002, bên thứ ba) để trừ tiền. Node.js + Express, dữ liệu trong bộ nhớ.

## Chạy

```bash
npm install

npm run bank                     # ngân hàng :4002  (DELAY_MS, FAIL_RATE, DROP_RATE qua env)
npm run fee                      # Fee Service :4001 — bản đã sửa
npm run fee:naive                # Fee Service :4001 — bản "trước khi sửa" để đo so sánh

# Đo tự động từng tình huống (script tự bật/tắt ngân hàng với env đúng tình huống)
npm run s1        # thêm  -- --naive  để đo bản trước khi sửa, ví dụ: npm run s1 -- --naive
npm run s2
npm run s3
npm run s4
npm run test:all  # chạy cả 4 tình huống ở cả hai bản, in tổng kết
```

Bật ngân hàng với lỗi giả lập (PowerShell / bash):

```powershell
$env:DELAY_MS=5000; npm run bank          # PowerShell
```
```bash
DROP_RATE=0.3 npm run bank                # bash
```

## API

### Fee Service — `:4001`

| Method | Path | Mô tả |
|---|---|---|
| GET | `/students/{id}/fees` | Công nợ. SV 1: 50.000.000đ · SV 2: 0 · SV 3: 3.200.000đ |
| POST | `/students/{id}/payments` | Body `{"amount": 100000}`. Tạo lệnh P1, P2…, gọi ngân hàng |
| GET | `/payments` | Danh sách lệnh + thống kê theo trạng thái, tổng tiền PAID |
| GET | `/payments/{id}` | Chi tiết một lệnh |

Quy ước kết quả thanh toán:

| Tình trạng | HTTP | status |
|---|---|---|
| Ngân hàng xác nhận đã trừ tiền | 201 | `PAID` |
| Ngân hàng từ chối rõ ràng (vượt hạn mức…) | giữ mã ngân hàng, ví dụ 402 | `FAILED` |
| Chắc chắn chưa trừ tiền (không kết nối được) | 503 | `FAILED` |
| Không biết đã trừ hay chưa (hết giờ / đứt khi đang chờ) | 504 | `PENDING` |

Thân lỗi luôn là `{ "error", "paymentId", "status" }`.

### Ngân hàng giả lập — `:4002`

| Method | Path | Mô tả |
|---|---|---|
| POST | `/charges` | `{"reference","amount"}` → 201 + `chargeId`; 400 số tiền không hợp lệ; 402 vượt hạn mức 20.000.000đ. Header `Idempotency-Key`: gửi lại cùng khóa → trả giao dịch cũ, không trừ thêm |
| GET | `/stats` | `{connections, requests, charges, duplicates}` |

Biến môi trường: `DELAY_MS`, `FAIL_RATE` (500 trước khi trừ tiền), `DROP_RATE` (trừ tiền xong rồi cắt kết nối). Giữ kết nối nhàn rỗi tối đa 5s (mặc định Node.js), in log mỗi kết nối TCP mới.

## Cách giải từng tình huống

Toàn bộ phần "sửa" nằm trong [src/fee/bank-client.js](src/fee/bank-client.js).

| # | Vấn đề | Cách xử lý |
|---|---|---|
| 1 | Ngân hàng tắt | `BANK_URL` từ env (mặc định `http://localhost:4002`). Connect timeout 500ms + ngân sách kết nối 1s: chưa từng kết nối được thì **chắc chắn chưa trừ tiền** → 503 nhanh. Mỗi lời gọi mở kết nối lại từ đầu nên ngân hàng lên là chạy được ngay, không cần restart Fee Service. |
| 2 | Ngân hàng chậm | **Deadline tổng 4s** cho mọi lần thử. Đã gửi yêu cầu mà hết giờ thì **không biết** ngân hàng đã trừ chưa → 504 `PENDING` (không phải FAILED). Gọi ngân hàng là I/O bất đồng bộ nên GET công nợ không bị chặn. |
| 3 | Tốn kết nối TCP | `http.Agent({ keepAlive: true })` dùng lại kết nối. Socket rảnh tự hủy sau **4s < 5s** keepAliveTimeout của ngân hàng → không dùng phải socket ngân hàng đã đóng (lỗi `ECONNRESET` kinh điển). Có thêm thử lại an toàn nếu vẫn dính race. |
| 4a | Đứt sau khi trừ tiền | Thử lại với **cùng `Idempotency-Key`** (`fee-<bootId>-<paymentId>`) → ngân hàng trả lại giao dịch cũ, không trừ lần hai. Hết lượt thử vẫn đứt → 504 `PENDING`, giữ tiền "đặt chỗ" và **đối soát nền** gửi lại cùng khóa mỗi 5s cho tới khi ra kết quả. |
| 4b | 500 tạm thời | Thử lại có backoff lũy thừa + jitter (100→800ms), tối đa 6 lần, trong deadline 4s. |
| 4c | 402 từ chối | Lỗi 4xx là kết luận rõ ràng → **không thử lại**, trả nguyên mã 402. |

Thêm: số tiền đang chờ (`pendingAmount`) bị trừ khi kiểm tra công nợ, để nhiều thanh toán song song không cùng vượt công nợ. Công nợ chỉ giảm khi ngân hàng trả 201.

## Số liệu đo (Windows 11, Node v24.21.0)

### Tình huống 1 — Ngân hàng tắt rồi bật lại

| Chỉ số | Trước khi sửa | Sau khi sửa |
|---|---|---|
| POST khi ngân hàng tắt | **500** `ECONNREFUSED`, 47ms | **503** FAILED, 584ms |
| GET công nợ khi ngân hàng tắt | 200, 1ms | 200, 2ms |
| POST sau khi bật ngân hàng (không restart Fee) | 201 | 201 |
| `BANK_URL=http://localhost:4999` | 500, 31ms | 503, 475ms |
| Tiêu chí đạt | 6/8 | **8/8** |

Bản cũ không sập nhưng trả sai mã (500 thay vì 503), client không phân biệt được "lỗi hệ thống" với "ngân hàng không kết nối được, chắc chắn chưa trừ tiền". Bản mới thử lại vài lần trong 1s (bắt kịp trường hợp ngân hàng vừa lên) rồi mới kết luận 503.

### Tình huống 2 — Ngân hàng chậm 5 giây

| Chỉ số | Trước khi sửa | Sau khi sửa |
|---|---|---|
| Một thanh toán | 201, **5067ms** | **504 PENDING, 4056ms** |
| 20 thanh toán song song (chậm nhất) | 5032ms | 4021ms, 20 × 504 PENDING |
| GET công nợ trong lúc chờ (max) | 5ms | 3ms |
| Tiêu chí đạt | 1/4 | **4/4** |

GET công nợ nhanh ở cả hai bản vì Node.js không chặn event loop khi chờ I/O. Vấn đề của bản cũ là sinh viên phải chờ vô thời hạn (ngân hàng chậm 30s thì chờ 30s). Các lệnh PENDING sau đó được đối soát nền chuyển sang PAID khi ngân hàng trả lời.

### Tình huống 3 — Duy trì kết nối (200 thanh toán, 10 cùng lúc)

| Chỉ số | Trước khi sửa | Sau khi sửa |
|---|---|---|
| Thành công | 200/200 | 200/200 |
| Tổng thời gian | 241ms | 147ms |
| `connections` ở ngân hàng | **201** | **11** |
| 5 yêu cầu sau 6 giây nhàn rỗi | 5/5 | 5/5 |
| Tiêu chí đạt | 2/3 | **3/3** |

`connections` có tính cả kết nối của script đọc `/stats` (+1). Fee Service bản mới chỉ mở 10 kết nối, đúng bằng số yêu cầu đồng thời. Trên localhost bắt tay TCP rẻ nên chỉ nhanh hơn ~40%; qua mạng thật (thêm TLS, RTT vài chục ms) thì chênh lệch lớn hơn nhiều.

> Bài học phụ khi viết script đo: chính client của script cũng giữ keep-alive tới Fee Service, và lần đầu đã dính `ECONNRESET` sau 6 giây nhàn rỗi vì server Node đóng socket rảnh sau 5s. Cách sửa giống hệt: cho socket rảnh tự hủy trước 5s (`timeout: 4000`).

### Tình huống 4 — Đứt giữa chừng, lỗi tạm thời, bị từ chối

| Chỉ số | Trước khi sửa | Sau khi sửa |
|---|---|---|
| (a) `DROP_RATE=0.3`, thành công | 37/60 | **60/60** |
| (a) lệnh hỏng trả về | 23 × 500 FAILED | — (nếu có: 504 PENDING) |
| (a) `charges` ngân hàng / lệnh PAID | **60 / 37** | 60 / 60 |
| (a) `duplicates` | 0 | 0 |
| (b) `FAIL_RATE=0.3`, thành công | 37/60 | **60/60** |
| (b) `requests` / `charges` / `duplicates` | 60 / 37 / 0 | 78 / 60 / 0 |
| (c) 25.000.000đ | 402, ngân hàng nhận 1 yêu cầu | 402, ngân hàng nhận 1 yêu cầu |
| Thời gian chậm nhất | 79ms | 460ms (≤ 4,5s) |
| Tiêu chí đạt | 9/12 | **12/12** |

**Phát hiện quan trọng nhất ở 4a bản cũ:** ngân hàng đã trừ tiền 60 lần nhưng Fee Service chỉ ghi nhận 37 lệnh PAID. 23 sinh viên **bị trừ tiền mà công nợ không giảm**, và còn bị báo "FAILED", nên họ sẽ bấm thanh toán lại và bị trừ lần nữa. Bản mới thử lại với cùng `Idempotency-Key`: 83 yêu cầu nhưng chỉ 60 lần trừ tiền, `duplicates = 0`.

Vì sao **phải** có Idempotency-Key mới được thử lại: nếu chỉ thêm vòng thử lại mà không có khóa, mỗi lần đứt sau khi trừ tiền sẽ thành một lần trừ trùng (`duplicates > 0`). Thử lại và idempotency phải đi cùng nhau.

## Cấu trúc

```
src/bank/server.js       ngân hàng giả lập
src/fee/server.js        Fee Service: API, công nợ, đặt chỗ tiền, đối soát nền
src/fee/bank-client.js   gọi ngân hàng: keep-alive, deadline, retry, idempotency, phân loại kết quả
scripts/scenario1..4.js  đo tự động từng tình huống (thêm --naive để đo bản trước khi sửa, --verbose để xem log service)
scripts/run-all.js       chạy hết, in tổng kết
```

Biến môi trường Fee Service: `BANK_URL`, `BANK_DEADLINE_MS` (4000), `BANK_CONNECT_TIMEOUT_MS` (500), `BANK_CONNECT_BUDGET_MS` (1000), `BANK_MAX_ATTEMPTS` (6), `BANK_FREE_SOCKET_TIMEOUT_MS` (4000), `RECONCILE_INTERVAL_MS` (5000), `FEE_MODE=naive`.

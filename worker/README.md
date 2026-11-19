# Card Card Fruit 後台（PSA 查詢）

呢個資料夾係 app 嘅後台，放喺 Cloudflare Workers（有免費級別）。佢做三樣嘢：

1. **證書查詢**：客人輸入 PSA 證書編號，後台問 PSA，傳返評級資料。
2. **送評進度**：客人輸入團號 + 帳單號碼。後台先喺本店記錄核對兩個號碼對唔對得上，對得上先問 PSA。
3. **帳單記錄管理**：本店登記「帳單號碼 → 團號」，評級出咗之後再登記證書編號。

PSA 通行證只會存喺 Cloudflare，**唔會出現喺網頁或者 GitHub**。

**而家嘅設定**：Cloudflare Worker `card-card-fruit-api` 已經連接呢個 repo（分支 `main`、路徑 `/worker`）。`worker/` 入面有改動 push 上 `main`，Cloudflare 就會自動部署，唔使再做下面第 1 至 5 步。

```
客人手機 ──> app（GitHub Pages）──> 後台（Cloudflare Worker）──> PSA 官方 API
                                        │
                                        └─ 帳單記錄（Cloudflare KV）
```

---

## 部署步驟（第一次大約 15 分鐘）

要準備：一部有 [Node.js](https://nodejs.org)（18 或以上）嘅電腦、一個 Cloudflare 免費帳戶、一個 PSA 帳戶。

以下指令全部喺 `worker` 資料夾入面執行。

### 1. 登入 Cloudflare

```bash
npx wrangler login
```

會開瀏覽器叫你登入 Cloudflare 同授權。

### 2. 建立帳單記錄嘅儲存位置

```bash
npx wrangler kv namespace create RECORDS
```

佢會顯示一個 `id`。打開 `wrangler.toml`，將 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID` 換成呢個 id。

### 3. 攞 PSA 通行證

1. 用本店送評嗰個 PSA 帳戶，登入 <https://www.psacard.com/publicapi/documentation>。
2. 喺嗰頁產生 access token，複製低。

### 4. 將兩個密碼存入 Cloudflare

```bash
npx wrangler secret put PSA_TOKEN
```

貼上 PSA 通行證，撳 Enter。

```bash
npx wrangler secret put ADMIN_KEY
```

自己諗一個長嘅密碼（建議 30 個字元以上，亂數），呢個係本店登記帳單用嘅。

### 5. 上線

```bash
npx wrangler deploy
```

完成之後會顯示後台網址，例如 `https://card-card-fruit-api.xxxx.workers.dev`。

### 6. 將後台網址填入 app

打開 repo 最外面嘅 `index.html`，搵 `var API_BASE='';`，改成：

```js
var API_BASE='https://card-card-fruit-api.xxxx.workers.dev';
```

儲存上載之後，app 就會查真實 PSA 資料。冇填嘅話，app 會繼續用示範資料。

---

## 日常操作：登記帳單

每次幫客人送評，就登記一次。將 `你的後台網址` 同 `你的 ADMIN_KEY` 換成真實資料。

**新增或者修改帳單：**

```bash
curl -X PUT "你的後台網址/api/admin/records/CCF-0001" \
  -H "Authorization: Bearer 你的 ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"group":"25123456","type":"submission","cards":5,"level":"Value","date":"2026-11-19"}'
```

- `group`：團號（PSA 嘅號碼）
- `type`：團號係 PSA 嘅 submission number 就填 `submission`；係 order number 就填 `order`
- `cards`、`level`、`date`：卡數、服務級別、送評日期，會顯示俾客人睇

**評級公佈之後，加埋證書編號**（客人就會見到每張卡嘅評級）：

```bash
curl -X PUT "你的後台網址/api/admin/records/CCF-0001" \
  -H "Authorization: Bearer 你的 ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"group":"25123456","type":"submission","cards":5,"level":"Value","date":"2026-11-19","certs":["12345678","87654321"]}'
```

**睇返一張帳單：**

```bash
curl "你的後台網址/api/admin/records/CCF-0001" -H "Authorization: Bearer 你的 ADMIN_KEY"
```

**刪除帳單：**

```bash
curl -X DELETE "你的後台網址/api/admin/records/CCF-0001" -H "Authorization: Bearer 你的 ADMIN_KEY"
```

---

## 已經處理咗嘅保護

- **對唔上就唔問 PSA**：團號同帳單號碼要喺本店記錄對得上，先會問 PSA。對唔上同搵唔到係同一個回應，有人亂試號碼都估唔到邊個係真。
- **暫存**：證書資料暫存 1 日，送評進度暫存 15 分鐘，慳 PSA 每日查詢次數。
- **限流**：同一個 IP 每 10 分鐘最多查 30 次。
- **只接受 app 網址**：`ALLOWED_ORIGIN` 以外嘅網站，瀏覽器唔會俾佢用呢個後台。

## 上線前要確認

1. **PSA 每日次數**：免費帳戶每日 100 次。客人多嘅話，要電郵 PSA 傾付費計劃。
2. **團體送評睇唔睇到**：用本店帳戶嘅通行證，查唔查到以團體名義送評嘅訂單。
3. **團號係邊種號碼**：收據上嘅團號，係 PSA 嘅 submission number 定 order number（決定 `type` 填乜）。
4. **進度步驟名稱**：PSA 文件只寫咗步驟係 0 至 8，冇寫每個數字代表咩。app 而家假設次序係「已到達、訂單準備、資料核對、評級、封裝、品質檢查一、品質檢查二、準備寄出、已寄出」。第一次查到真實訂單時，同 PSA 網站顯示嘅進度對一對；唔啱就改 `index.html` 入面嘅 `PSA_STEP_NAMES`。
5. **通行證有效期**：如果 app 開始顯示「暫時連唔到 PSA」，可能係通行證過期。去 PSA 網站產生新嘅，再做一次第 4 步嘅 `PSA_TOKEN` 就得，唔使改 app。

## 測試

```bash
node --test test/worker.test.mjs
```

測試用模擬嘅 PSA 回應，唔會真係連 PSA，亦唔使通行證。

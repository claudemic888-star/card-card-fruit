# Card Card Fruit

PSA 鑑定查詢同卡牌遊戲報名 app 嘅原型。

- **App**：`index.html`，經 GitHub Pages 發佈喺 <https://claudemic888-star.github.io/card-card-fruit/>
- **後台**：`worker/`，Cloudflare Worker，負責接駁 PSA 官方 API。部署方法見 [worker/README.md](worker/README.md)。

`index.html` 入面 `API_BASE` 留空時係示範模式；填咗後台網址就會查真實 PSA 資料。

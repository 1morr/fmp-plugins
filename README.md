# fmp-plugins

[FMP](https://github.com/1morr/FMP) 的官方音源插件。**開發中**：FMP 正在重寫（見 FMP 的 `docs/adr/`），插件格式與宿主 API 在重寫完成前仍可能變動，目前沒有發佈版本。

## 結構

每個插件一個目錄：

- `<插件>.js`：安裝檔。開頭的 `/* ==FMP Plugin== … ==/FMP Plugin== */` 是 JSON manifest，其餘是腳本（FMP ADR 0014）。
- `checks.json`：每個能力一條檢查案例。
- `fixtures/`：錄下的 HTTP 請求與回應，已遮蔽憑證，供契約測試重播。

欄位與宿主 API 的型別見 FMP 的 `app/lib/plugins/types/fmp-plugin.d.ts`。

## 契約測試

契約執行器在 FMP 裡。checkout FMP 後，在它的 `app/` 目錄執行：

```sh
FMP_PLUGIN_DIR=<本 repo 的絕對路徑>/bilibili flutter test test/plugins/contract/contract_test.dart
```

重播不連網。錄製（真實連線、只限不需要登入的案例）另加 `--run-skipped --tags live` 並改跑 `test/plugins/contract/record_test.dart`，詳見 FMP 的 `app/AGENTS.md`。

## 授權

MIT，見 `LICENSE`。

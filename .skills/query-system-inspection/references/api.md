# 自动巡检查询接口

基础地址：`https://apps-itsm.ceic.com/autosystemcheck/api/open/`。两个接口均使用 HTTPS GET，保留路径末尾的 `/`，参数通过 URL 查询字符串传递。测试工号为 `e0128483`。

## 获取所属应用

`GET systemList/?userCode={工号}`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `userCode` | 是 | 员工工号 |

成功响应结构（示例仅节选一个应用）：

```json
{
  "code": 0,
  "message": "OK",
  "data": {
    "count": 1,
    "list": [
      {"bizId": 89, "bizName": "集团境外应急指挥系统"}
    ]
  }
}
```

从实际 `data.list` 获取应用名称与编码；这里的示例不代表该用户完整或固定的应用清单。

## 获取巡检报告

`GET systemReportContent/?userCode={工号}&bizId={应用编码}&reportType={类型}&reportDate={日期}`

| 参数 | 必填 | 含义 |
| --- | --- | --- |
| `userCode` | 是 | 与应用列表查询相同的员工工号 |
| `bizId` | 是 | 该工号的 `systemList` 响应中的应用编码 |
| `reportType` | 是 | `1` 日报、`2` 周报、`3` 月报 |
| `reportDate` | 是 | 日报 `2026-09-06`；周报 `2026-08-31~2026-09-06`；月报 `2026-08` |

成功响应结构（HTML 内容已省略）：

```json
{
  "code": 0,
  "message": "OK",
  "data": "<!DOCTYPE html>..."
}
```

2026-09-09 使用提供的工号和 `bizId=89` 实测，应用列表、日报 `2026-09-06`、周报 `2026-08-31~2026-09-06` 和月报 `2026-08` 均查询成功，业务 `code=0`。报告 `data` 为 HTML，包含报告标题、日期、生成时间、巡检指标、表格、AI 结论以及图表脚本。此处记录的是已观察到的成功结构；空数据与业务失败的完整结构尚未由接口文档定义，不臆造状态码含义。

接口 JSON 的 `data` 为 HTML 是正常成功响应；HTTP 响应本身是 HTML（例如登录页）则不符合已验证的接口结构。HTML 内的图表可能依赖 JavaScript 和外部 ECharts 资源，纯文本提取只能用于正文及静态表格。

实测月报的 AI 结论位于空节点的 `data-ai-html` 属性中，直接读取普通文本节点会漏掉该结论；分析报告时应先解码属性，再将属性值作为 HTML 片段读取。表格的 `data-full` 是完整单元格文本，宜作为截断显示文本的替代值，避免追加后重复。

## 直接使用 curl

使用 `--fail` 兼容 Windows 10 自带的较旧 curl。它让 HTTP 4xx/5xx 返回非零退出码，但不会识别 HTTP 200 下的业务错误；需要查看 HTTP 错误正文时，可以去掉 `--fail` 并用 `--write-out "HTTP_STATUS=%{http_code}"` 单独检查 HTTP 状态，不能把错误正文当成报告。

以下为 PowerShell 可执行示例。其他系统将 `curl.exe` 替换为 `curl`。`--data-urlencode` 负责参数编码；周报中的 `~` 不加反斜杠，URL 中的 `&` 也不应写成 `\&`。

```powershell
curl.exe --get --fail --silent --show-error --connect-timeout 10 --max-time 20  -H "Content-Type: application/json" --data-urlencode "userCode=e0128483" "https://apps-itsm.ceic.com/autosystemcheck/api/open/systemList/"

curl.exe --get --fail --silent --show-error --connect-timeout 10 --max-time 20  -H "Content-Type: application/json" --data-urlencode "userCode=e0128483" --data-urlencode "bizId=89" --data-urlencode "reportType=1" --data-urlencode "reportDate=2026-09-06" "https://apps-itsm.ceic.com/autosystemcheck/api/open/systemReportContent/"

curl.exe --get --fail --silent --show-error --connect-timeout 10 --max-time 20  -H "Content-Type: application/json" --data-urlencode "userCode=e0128483" --data-urlencode "bizId=89" --data-urlencode "reportType=2" --data-urlencode "reportDate=2026-08-31~2026-09-06" "https://apps-itsm.ceic.com/autosystemcheck/api/open/systemReportContent/"

curl.exe --get --fail --silent --show-error --connect-timeout 10 --max-time 20  -H "Content-Type: application/json" --data-urlencode "userCode=e0128483" --data-urlencode "bizId=89" --data-urlencode "reportType=3" --data-urlencode "reportDate=2026-08" "https://apps-itsm.ceic.com/autosystemcheck/api/open/systemReportContent/"
```

这些 curl 命令返回完整 JSON。报告需先解析 JSON 再读取 `data`；直接将 curl 输出保存为 `.html` 得到的仍是 JSON，不是可独立打开的报告 HTML。检查 HTTP 状态后还需检查业务 `code`。

## 保存报告

需要保留完整响应时，在所选报告命令末尾添加 `--output "inspection-report.json"`。使用 curl 的 `--output` 保存原始响应字节，避免 Windows PowerShell 5.1 的 `>` 重定向改变编码。选择合适的保存目录及文件名，同名文件会被覆盖。

仅在 curl 成功完成并保存 JSON 后，使用 Windows 自带 PowerShell 提取 HTML：

```powershell
$inspectionResponse = Get-Content -LiteralPath "inspection-report.json" -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ($null -eq $inspectionResponse.code -or $inspectionResponse.code -ne 0) { throw "接口未成功返回：$($inspectionResponse.message)" }
if ($inspectionResponse.data -isnot [string] -or [string]::IsNullOrWhiteSpace($inspectionResponse.data)) { throw "未返回报告 HTML 正文" }
$inspectionHtmlPath = Join-Path (Get-Location).Path "inspection-report.html"
[System.IO.File]::WriteAllText($inspectionHtmlPath, $inspectionResponse.data, [System.Text.UTF8Encoding]::new($false))
```

此步骤只读取本地 JSON 并导出其中的 HTML，不执行报告中的 JavaScript。

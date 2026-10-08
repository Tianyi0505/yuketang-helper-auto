# 自动答题诊断与离线回归

自动答题日志保存在现有应用日志中；关闭声音、弹窗或系统通知不会关闭日志。更新构建后需重启桌面程序。

在诊断页刷新日志，或通过 CLI 读取：

```powershell
node apps/cli/dist/ykt-cli.cjs logs list --limit 5000 |
  ConvertFrom-Json |
  Where-Object { $_.scope -in @('automation', 'answer-request', 'answer') } |
  ConvertTo-Json -Depth 8
```

- `automation`：排队、开始分析、生成建议、开始提交、成功、失败、跳过；记录题目/课堂 ID、截止时间、剩余毫秒、排队延迟、托管提交状态和跳过原因。失败不会重新排队，日志会明确说明。
- `answer-request`：每次提交的路由（`answer` / `retry`）、自动/手动确认、建议 ID、尝试次数、耗时，以及凭据刷新前后的独立阶段。失败记录接口路径、方法、HTTP 状态、业务错误码及最多 1024 字符的脱敏服务端错误消息。
- 不保存请求头、答案正文、响应 `data` 或 URL 查询参数。Cookie、Authorization 等敏感文本继续通过现有脱敏处理。新增诊断写入失败不会阻断答题。

## 已验证的调用链问题

1. 官方页面收到 `Set-Auth` 后更新 `window.Authorization` 和 `localStorage.Authorization`。内置 `ElectronSessionCredentialSource.load()` 能读取更新值，但旧 `SessionManager.headers()` 始终优先使用非空缓存，导致后续自动提交继续发送旧值。现在识别来源值变化，同时避免未更新的页面值覆盖主动请求刚收到的更新凭据。
2. 官方错误码 `50004` 表示课堂已经结束，旧实现却把它识别成凭据过期并签到。签到若失败，最终错误会变成 HTTP 400，掩盖最初的业务原因。现在保留课堂结束错误，仅 HTTP 401 进入一次凭据刷新重试，并分别记录原始提交和刷新结果。
3. 签到请求补齐官方页面按课堂 ID 签到时发送的 `source: 1`。

协议核对日期：2026-09-24。只读取了官方公开静态脚本，没有向课堂发送答案或签到请求：

- [官方课堂入口脚本](https://fe-static-yuketang.yuketang.cn/fe/static/lesson/3.3.236/js/fullscreen.9a6559b7a061cfe67e80.js)：错误码映射和 v3 课堂加载路由。
- [官方 v3 课堂模块](https://fe-static-yuketang.yuketang.cn/fe/static/lesson/3.3.236/js/12.2c1823b4b49f34618d9e.js)：`checkin`、`handleResponse` 和请求凭据读取实现。

## 复现与边界

`tests/contract/ai-automation.test.ts` 经过浏览器收集器、题目状态机、Renderer 自动轮询、内置凭据读取、Facade、主动 HTTP 客户端与日志存储；外部网络及模型由测试替身提供。覆盖两课堂并行、提交 HTTP 400、HTTP 401 后签到 HTTP 400、网络异常、课堂结束和网页凭据轮换。

对照运行中暂时恢复旧凭据选择和旧 `50004` 判断，其余保留新日志：`lesson-ended` 和 `browser-rotated-auth` 两条回归均失败；恢复修复后均通过。它验证了生产调用链中的缺陷，不是直接调用私有方法制造状态。

历史日志证明 08:20:40 自动提交链路失败，当时距题目截止约 50 秒；但没有保存当时的请求和响应正文。因此此次是按照已核对的协议与实际失败路径进行离线模拟，不能断言历史请求一定属于上述哪一种原因，也不能证明真实课堂已经补交成功。

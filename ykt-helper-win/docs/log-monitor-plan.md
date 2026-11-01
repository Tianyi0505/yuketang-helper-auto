# 课堂问题复发日志监控方案

- 状态：已实施
- 日期：2026-10-20
- 适用范围：`ykt-helper-win`（雨课堂助手 Electron 桌面端），基线提交 `0cd43c8`
- 配套脚本：`scripts/log-monitor.mjs`；配套自动化：每小时执行的日志监控定时任务
- 人工可读运行台账：`../.workbuddy/memory/watchdog.md`（由监控执行体追加）

## 1. 目标

此前已修复的六类课堂问题在上线后可能因代码变更或环境因素复发。本方案通过**每小时一次的日志监控定时任务**，自动完成：

0. **保证桌面端常驻**：每次运行发现应用未运行即启动（无论退出原因），确保课堂期间始终可用；
1. 读取并分析桌面端运行日志，判定六类已修复问题是否复发；
2. 若复发：先终止旧进程、启动新进程完成**临时修复**（清空内存中的陈旧监听与待绑定状态）；
3. 随后对代码进行**正式修复**并验证；
4. 验证通过后再次终止旧进程、启动新进程，加载修复后的代码；
5. 全程记录运行结果，并在必要时通知用户。

### 监控的六类已修复问题

| #   | 问题                     | 修复提交中的对应改动                                                 |
| --- | ------------------------ | -------------------------------------------------------------------- |
| 1   | 上课切换后未跟随新开课   | 收到下课事件或完整开课列表确认旧课堂不在列表时关闭监听、取消前端排队 |
| 2   | 课堂生命周期清理         | `closeLesson` / `endedLessonIds` / 待绑定事件清理、未答开放题过期    |
| 3   | 课件按页面归属           | 课件响应按 CDP 请求发起时的页面课堂 ID 绑定，不跨标签猜测            |
| 4   | 按题目事件补取课件       | unlock 事件携带课件 ID 时主动补取课件再绑定                          |
| 5   | 关闭标签释放监听         | 标签关闭时释放该标签的 socket/context 映射并停止对应课堂监听         |
| 6   | 回顾页习题同步与自动补交 | 解析 `classroom-report` 回顾响应，面板同步回顾习题并自动补交未作答题 |

## 2. 触发方式

- **调度**：WorkBuddy recurring 自动化，规则 `FREQ=HOURLY;INTERVAL=1`（每小时一次，全天候）。
- **执行体**：自动化运行时代理按本方案第 5 节的流程执行；所有确定性操作（日志读取、判定、进程管理、记录）由 `scripts/log-monitor.mjs` 完成。
- **补跑策略**：错过的时间点不补跑；每次运行相互独立，扫描起点为**上次成功扫描的时间水位线**（`logs/monitor/state.json` 的 `lastScanAt`），因此停机数小时后的首次运行会覆盖停机期间的全部日志，不会漏检。
- **手动触发**：可在仓库根目录直接执行脚本子命令（见第 8 节）。

## 3. 日志来源与监控范围

### 3.1 日志来源

应用日志写入 SQLite：`%APPDATA%\@ykt\desktop\storage\yuketang.sqlite`（WAL 模式，表 `logs`，字段 `id/timestamp/level/scope/message/details`，上限 5000 条）。

脚本按以下顺序解析数据库路径（可用环境变量 `YKT_LOG_DB` 覆盖）：

1. `$YKT_LOG_DB`
2. `%APPDATA%\@ykt\desktop\storage\yuketang.sqlite`（开发态）
3. `%APPDATA%\雨课堂助手\storage\yuketang.sqlite`（打包态 productName）
4. `%APPDATA%\YuketangHelper\storage\yuketang.sqlite`

读取使用只读连接；WAL 热日志阻止只读打开时退回复用读写连接。扫描不写入应用数据。

### 3.2 监控范围

- **scope**：`lesson`（课堂事件）、`automation`（自动答题流水线）、`answer-request` / `answer`（提交链路）、`runtime`（运行时启停）、`ai` / `ai-profile`（辅助）。
- **时间窗**：`[lastScanAt, now]`；首次运行（无水位线）回看 `--window-hours`（默认 2 小时）。
- **课堂结束基准**：`课堂已结束，已停止监听。` 可能早于监控窗口，因此在全量日志中取每个课堂最后一次结束时间作为 H5/H6 的判定基准。
- **健康信号**：进程存活状态（`tasklist` 按窗口标题/映像名识别）与 `课堂列表已刷新。` 的最后时间。

## 4. 问题判定条件

判定输出三档：`ok`（无信号）、`warning`（仅 1 条中危信号）、`recurrence`（任一高危信号，或 ≥2 条中危信号）。`recurrence` 触发第 5 节完整处置流程。

### 4.1 高危信号（任一出现即判定复发）

| ID  | 信号                 | 判定条件                                                                                                                                   | 对应问题      |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| H1  | 题目事件绑定受阻     | 同一 `problemId` 出现 `题目事件等待课件绑定。`，且此后 5 分钟内没有 `已从官方课堂收集题目事件。` / `已应用题目发布事件到状态机。` 完成绑定 | 3、4          |
| H2  | 题目事件无法绑定     | 任一 `官方题目事件无法绑定。`                                                                                                              | 3、4          |
| H3  | 补取课件持续失败     | 同一 `(lessonId, presentationId)` 的 `按题目事件补取课件失败。` ≥2 次                                                                      | 4             |
| H4  | 结束事件重复         | 同一 `lessonId` 的 `课堂已结束，已停止监听。` 在窗口内 ≥2 次（`firstFinish` 去重失效）                                                     | 2             |
| H5  | 结束后仍产生课堂事件 | 该课堂结束日志之后仍出现其课堂事件（收集题目/课件/补取/发布等；回顾页 `report-<lessonId>` 课件属设计内同步，不计入） | 1、2、5       |
| H6  | 结束后仍自动答题     | 结束日志之后仍出现该课堂 `自动答题已排队/开始分析/已生成建议/开始提交`                                                                     | 1、2          |
| H7  | 回顾页自动答题失败   | `自动答题失败，本轮不会重新排队。` 且 `details.report = true`                                                                              | 6             |
| H8  | 回顾页补交失败       | `答案请求失败。` 且 `details.route = 'retry'`（retry 仅用于回顾补交/强制重试）                                                             | 6             |
| H9  | 提交连续失败         | 同一 `problemId` 连续 3 次 `答案请求失败。` 且无成功间隔                                                                                   | 6（提交链路） |

### 4.2 中危信号（单独出现记为 warning，不触发修复流程）

| ID  | 信号             | 判定条件                                                                                                                |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- |
| M1  | 凭据刷新失败     | 任一 `课堂凭据刷新失败，未重试提交。`                                                                                   |
| M2  | 课堂数据解析失败 | `官方课堂数据解析失败。` ≥2 次（观察链路错投/解析回归）                                                                 |
| M3  | 轮询停滞         | 进程存活但超过 45 分钟无 `课堂列表已刷新。`（应用疑似卡死）                                                             |
| M4  | 疑似崩溃退出     | 进程已退出，但 90 分钟内仍有 `课堂列表已刷新。`（近期曾运行；窗口大于监控周期，保证两次运行之间退出也能被下次扫描识别） |

> 说明：合法并行课堂会产生两个课堂的交错事件，因此“多课堂并发”本身不构成信号；H5/H6 均以**该课堂自己的结束日志**为基准，避免误报。
>
> `process.appExitedCleanly`（最后一次课堂轮询之后是否有干净的 `Backend runtime stopped.`）仅作诊断信息：用户要求应用常驻，因此**无论退出原因**，只要进程未运行就唤活（见 5.1）。

## 5. 执行顺序（复发处置流程）

```
第 0 步 确保常驻守护（guard，幂等）
 ├─ 已有守护 ──► 继续
 └─ 无守护 ────► 后台启动 guard 循环（30 秒检查，退出即重启）

scan（只读）
 ├─ ok / warning
 │    ├─ process.running=false ──► 等 90 秒（守护应已唤活）；仍未运行则手动 start && await-exit → record(revived)
 │    └─ process.running=true ───► record 记录，结束（warning 列入下次通知）
 └─ recurrence
      ├─ 1. 临时修复：stop 终止旧进程 → start 启动新进程（长驻后台守护）
      ├─ 2. 正式修复：按 signals 定位代码 → 最小改动修复
      │      → npm run build → npm test → npm run lint → 提交（仅本次相关文件）
      ├─ 3. 加载修复：stop → start（长驻后台守护）
      ├─ 4. 冒烟验证：以最终重启时间为 --since 执行 scan
      │      ├─ 无同类信号 ──► record(fixed) + 邮件通知
      │      └─ 仍有同类信号 ─► record(failed) + 告警邮件，不再循环重启
      └─ 任一步骤失败 ─► 按第 6 节处置
```

### 5.1 常驻唤活（应用未运行即启动）

用户要求桌面端**常驻**：监控只有在应用运行时才有日志可读，因此每次扫描只要发现 `process.running=false`（无论干净退出、被关闭、崩溃还是宿主回收），都按第 6.2 节的长驻后台方式启动应用，记录 `--status revived`，不发送邮件（避免每小时骚扰）。`process.needsRevive=true` 是该判断的显式标记；`appExitedCleanly` 仅用于诊断记录。

若唤活启动失败，记录 `--status failed` 并告警；若上一次运行也是“唤活失败”，本次只记录、不重复发邮件，避免每小时轰炸。

要点：

1. **先重启、后修码**：临时修复只清内存状态，不改变代码，保证课堂尽快恢复可用；正式修复随后进行。
2. **两次重启的意义**：第一次让陈旧监听/待绑定状态立即失效；第二次让修复后的代码真正生效（运行中的进程不会热更新）。
3. **信号到代码的定位**：
   - H1/H2/H3 → `packages/routing/src/active/browser-lesson-collector.ts`（`findLesson` 页面归属）与 `packages/backend/src/services/active-lesson-service.ts`（`ensurePresentationForUnlock` 补取）；
   - H4/H5/H6 → `active-lesson-service.ts`（`refreshLessons` / `finishLesson`）与 `apps/desktop/renderer/src/auto-join.ts`（切换跟随）；
   - H5（标签相关）→ `browser-lesson-collector.ts`（`releaseContext`）与 `apps/desktop/main/electron-network-observer.ts`（`destroy`）；
   - H7/H8/H9 → `browser-lesson-collector.ts`（`observeClassroomReport`）、`packages/routing/src/active/exam-review-session.ts`、`AssistantPanel.vue` 回顾题自动答题/补交与 `answer-service.ts`。
4. **提交纪律**：只 `git add` 本次修复涉及的文件；工作区可能存在无关的未提交改动（如 AI profile 相关），严禁一并提交或修改；不执行 `git push`（是否推送由用户决定，通知邮件中会说明）。

## 6. 失败处理与重试策略

| 失败点                                        | 处置                                                                                                    | 重试             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| scan 脚本本身失败（DB 缺失、SQLite 不可用等） | `record(failed)` + 告警邮件，**不修改代码、不重启**                                                     | 下一小时自然重试 |
| 临时修复 start 失败                           | 策略序列已内置回退（见 6.1）；全部失败则 `record(failed)` + 告警邮件，保留现场                          | 下一小时重试     |
| 正式修复中构建/测试/lint 失败                 | 回滚本次改动（仅限自己改的文件），`record(failed)` + 告警邮件；此时进程已是临时修复后的干净状态，可接受 | 下一小时重新检测 |
| 冒烟验证仍检出同类信号                        | 认定修复无效，`record(failed)` + 告警邮件，**不再循环重启**（避免重启风暴）                             | 人工介入         |
| stop 后进程未死                               | 记录 PID，start 前会再次 stop；持续残留由告警邮件暴露                                                   | 下一小时         |
| 应用整体无法启动（环境故障）                  | 启动策略全部失败时邮件中附带 `logs/monitor/start-*.log` 路径与 GPU/驱动提示                             | 下一小时         |

### 6.1 启动策略序列（环境级回退）

`start` 按顺序尝试，成功后记入 `state.json` 的 `launchStrategy`，后续优先复用：

1. `default`：`electron.exe . --`（与 README 的 `npm start` 等价）；
2. `no-sandbox`：`electron.exe --no-sandbox . --`。本机 GPU 沙箱进程会访问违规崩溃（`exit_code=-1073741819`），导致默认策略启动即退；该策略为环境回退，成功后会记录并通知用户关注显示驱动/虚拟显示器问题。

启动判定采用**双信号**：主窗口标题 `雨课堂助手`（`tasklist`，按映像名过滤保证速度）或数据库中新实例的 `Backend runtime started.`（按日志 ID 水位线区分新旧实例）；启动后还需持续存活 12 秒才算成功，可滤除“启动即退出”的假阳性。

### 6.2 进程存活的宿主约束（重要）

宿主环境会在命令结束时终止其整个进程树（包括 detached 子进程）。因此让桌面端长期存活必须使用**长驻后台任务**。

**常驻守护（首选）**：用一个长驻后台任务运行守护循环，应用退出后约 60–90 秒自动重启：

```bash
node scripts/log-monitor.mjs guard > logs/monitor/guard.log 2>&1
```

- `guard` 幂等：心跳文件 `logs/monitor/guard.heartbeat` 记录守护自身 PID，已有存活守护时立即返回 `guarded=true`；死守护的陈旧心跳不会阻止新守护接管。
- 循环每 30 秒检查一次；应用连续两次检测未运行才唤活（防抖），唤活走与 `start` 相同的策略回退。
- **动作锁**：`stop` 写入 `actionLockAt`（5 分钟有效），启动成功后清除；守护在锁有效期内不插手，避免与定时任务的“停→启”动作互相打架。若启动失败，锁同时充当退避，5 分钟后守护再试。

**单次动作**：临时修复/加载修复时的重启用下面的组合命令（应用随该任务存活，任务结束时应用才可能退出，届时由守护接管）：

```bash
node scripts/log-monitor.mjs start --wait-seconds 90 && node scripts/log-monitor.mjs await-exit
```

`await-exit` 在应用退出前不返回。若守护与单个动作都因宿主会话结束而中断，下一次每小时扫描仍会通过 `needsRevive` 兜底启动。

### 6.3 进程识别与终止

- 主进程识别：窗口标题 `雨课堂助手`（`tasklist /fi "imagename eq electron.exe" /v /fo csv` 等，兼容打包态 `YuketangHelper.exe`）；辅以工作区 electron 路径匹配（`ps -W`）与 `state.json` 的 `managedPid`。
- 终止：对识别到的 PID 执行 `taskkill /pid <pid> /t /f`（整树），幂等；无进程时安全返回。
- 启动前强制 stop，规避单实例锁（`requestSingleInstanceLock`）导致新实例静默退出。
- 子进程环境会剔除宿主注入的 `ELECTRON_RUN_AS_NODE=1`（否则 Electron 以 Node 模式运行，启动即崩）。

## 7. 执行结果的通知与记录方式

### 7.1 记录（每次运行都写）

- 运行记录：`logs/monitor/monitor-YYYY-MM-DD.jsonl`，每行一条 `{at, status, summary, signals, details}`；`status ∈ ok | warning | recurrence | fixed | failed | revived`。
- 状态文件：`logs/monitor/state.json`，维护 `lastScanAt`（扫描水位线）、`lastVerdict`、`lastSignalIds`、`launchStrategy`、`managedPid`、`lastStartAt/StopAt`、`actionLockAt`、`lastGuardReviveAt`、`lastRun*`。
- 启动日志：`logs/monitor/start-<时间戳>-<策略>.log`（应用的 stdout/stderr，用于失败排查）。
- 人工台账：`../.workbuddy/memory/watchdog.md`（监控执行体每次运行追加一行摘要）。
- 目录 `logs/` 已加入 `.gitignore`，不进入版本库。

### 7.2 通知（Agent Mail，发给用户本人）

仅在以下情况发送，正常 `ok` / `warning` / `revived` 不发送（避免每小时骚扰）：

- 检测到复发并完成处置（`fixed`）：附判定证据、临时修复与正式修复的提交哈希、冒烟验证结果、当前进程状态；
- 任何步骤失败（`failed`）或 scan 脚本失败：附失败点、已采取的处置、相关日志路径；常驻唤活连续失败时，只在第一次失败发信，后续只记录，避免每小时轰炸；
- 启动策略回退到 `no-sandbox` 时，提示关注本机显示驱动/虚拟显示器可能的环境问题。

邮件发送前先获取用户邮箱地址（Agent Mail `GetMe`），再发送到该地址。

## 8. 脚本使用说明

```bash
# 扫描（JSON 输出；退出码 0=ok/warning，10=recurrence，1=脚本失败）
node scripts/log-monitor.mjs scan [--since <ISO>] [--window-hours 2]

# 进程与监控状态
node scripts/log-monitor.mjs status

# 终止 / 启动（detached + 多策略回退）
node scripts/log-monitor.mjs stop [--dry-run]
node scripts/log-monitor.mjs start [--wait-seconds 90] [--dry-run] [--force]

# 重启 = stop + start（注意宿主进程树约束，长驻场景请用 6.2 的组合命令）
node scripts/log-monitor.mjs restart [--wait-seconds 90]

# 常驻守护：每 30 秒检查，应用退出即自动重启（幂等；已有守护时立即返回）
node scripts/log-monitor.mjs guard > logs/monitor/guard.log 2>&1

# 单次动作守护：直到桌面端退出才返回
node scripts/log-monitor.mjs await-exit

# 记录一次运行结果
node scripts/log-monitor.mjs record --status fixed --summary "..." [--signals H1,H5] [--details '<json>']
```

## 9. 实施备注（2026-10-20 实测）

- 全量 `tasklist /v` 在本机需约 66 秒，按映像名过滤后约 0.5 秒；脚本一律使用过滤调用。
- 经 `cmd.exe /c` 传递含引号的命令会被转义为 `\"` 导致失败；脚本直接 spawn `electron.exe` 并以数组传参。
- 本机默认启动策略会因 GPU 沙箱进程访问违规而退出，`--no-sandbox` 可稳定运行；该现象属于环境问题（存在 Idd Virtual Monitor 虚拟显示器），已通过策略回退与通知机制兜底。
- 监控自身的运行记录位于 `logs/monitor/`，与应用运行日志（SQLite）分离，互不干扰。

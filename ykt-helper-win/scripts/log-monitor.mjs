#!/usr/bin/env node
/**
 * 雨课堂助手日志监控脚本。
 *
 * 由每小时定时任务调用：只读解析桌面端运行日志数据库，判定此前已修复的课堂
 * 相关问题是否复发，并在需要时执行“停旧进程 → 启新进程”的进程处置。
 * 代码级修复由定时任务的执行体（Agent）完成，本脚本不修改业务源码。
 *
 * 子命令：
 *   scan     读取并分析运行日志，输出 JSON 判定（ok / warning / recurrence）
 *   status   查看桌面端进程状态、监控水位线与最近记录
 *   stop     终止当前运行的桌面端进程（整树），幂等
 *   start    从本工作区重新启动桌面端进程（detached，多策略回退）
 *   restart  stop + start
 *   await-exit  守护进程：直到桌面端退出才返回（配合 start 放在长驻后台任务）
 *   guard   常驻守护：每 30 秒检查，应用退出即自动重启（幂等，已有守护时立即返回）
 *   record   记录一次监控运行结果（JSONL + state.json）
 *
 * 常驻策略：应用应在任何时候保持运行。推荐用一个长驻后台任务执行 `guard`
 * （自动化每次运行前用 `guard` 幂等确保守护存活）；`start && await-exit` 用于
 * 单次重启动作。
 *
 * 重要：宿主环境会在命令结束时终止其整个进程树（含 detached 子进程），
 * 因此需要让桌面端长期存活时，必须以“长驻后台任务”的方式执行：
 *   node scripts/log-monitor.mjs start --wait-seconds 90 && node scripts/log-monitor.mjs await-exit
 * 该组合命令在后台任务中持续运行，应用退出后才返回。
 *
 * 自身状态与记录位于 <repo>/logs/monitor/，不写入应用数据目录。
 * 用法与判定规则详见 docs/log-monitor-plan.md。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, '..');
const MONITOR_DIR = join(PROJECT_ROOT, 'logs', 'monitor');
const STATE_FILE = join(MONITOR_DIR, 'state.json');
const APP_TITLE = '雨课堂助手';
const ANSWER_WINDOW_TITLE = '雨课堂 · 作答';
const DIST_ENTRY = join(
  PROJECT_ROOT,
  'apps',
  'desktop',
  'dist',
  'main',
  'index.cjs',
);
const LOG_RETENTION_LIMIT = 5000;
const POLL_STALL_MINUTES = 45;
/**
 * M4「疑似崩溃退出」的活动回看窗口。需大于监控周期（1 小时）+ 最后一次
 * 轮询的间隔，保证应用在两次运行之间死亡时仍能被下一次扫描识别；
 * 配合 appExitedCleanly 区分用户手动关闭，不会误唤活。
 */
const APP_DEATH_WINDOW_MINUTES = 90;

/** 常驻守护：检查间隔、心跳有效期、动作锁有效期。 */
const GUARD_INTERVAL_MS = 30_000;
const GUARD_HEARTBEAT_FILE = join(MONITOR_DIR, 'guard.heartbeat');
const GUARD_HEARTBEAT_TTL_MS = 300_000;
const ACTION_LOCK_MINUTES = 5;

/** 课堂事件类日志：出现即代表该课堂仍在产生活动。 */
const CLASSROOM_EVENT_MESSAGES = new Set([
  '已从官方课堂收集题目事件。',
  '题目事件等待课件绑定。',
  '已从官方页面收集课件。',
  '已按题目事件补取课件。',
  '题目发布事件已接收，等待题目数据加载。',
  '已应用题目发布事件到状态机。',
  '题目事件关联已按题目 ID 修正。',
]);
/**
 * 回顾页（classroom-report）课件的 presentation id 前缀。课堂结束后应用会
 * 打开回顾页同步习题并自动补交，这类课件必然在“课堂已结束”之后被收集，
 * 属于第 6 项问题的设计内流程，不能当作“监听未释放”的证据。
 */
const REVIEW_PRESENTATION_PREFIX = 'report-';
/** 自动答题进入流水线的阶段（排队之后即视为旧任务未被取消）。 */
const AUTOMATION_ACTIVE_STAGES = new Set([
  'scheduled',
  'started',
  'generated',
  'submit-started',
]);
/** 题目事件等待课件绑定后，允许的实时绑定宽限时间（分钟）。 */
const BIND_GRACE_MINUTES = 5;
/** 题目绑定成功的日志消息。 */
const BIND_SUCCESS_MESSAGES = new Set([
  '已从官方课堂收集题目事件。',
  '已应用题目发布事件到状态机。',
]);

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function info(message) {
  process.stderr.write(`[log-monitor] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[log-monitor] 错误：${message}\n`);
  process.exit(1);
}

function warn(message) {
  process.stderr.write(`[log-monitor] 警告：${message}\n`);
}

function parseArgs(argv) {
  const positionals = [];
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) options.set(key, inline);
      else {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('--')) {
          options.set(key, next);
          index += 1;
        } else options.set(key, 'true');
      }
    } else positionals.push(arg);
  }
  return { positionals, options };
}

function isoNow() {
  return new Date().toISOString();
}

function fileStamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function ensureMonitorDir() {
  try {
    mkdirSync(MONITOR_DIR, { recursive: true });
  } catch (error) {
    // 宿主沙箱可能临时拒绝 logs/monitor 的写权限（EPERM / EACCES）。
    // 目录已存在时忽略该错误，避免守护循环因权限抖动直接崩溃。
    if (!existsSync(MONITOR_DIR)) throw error;
  }
}

/**
 * 子进程环境：去掉宿主（Agent 终端）注入的 ELECTRON_RUN_AS_NODE=1。
 * 该变量会让 Electron 以 Node 模式运行，启动时直接崩溃
 * （Cannot read properties of undefined (reading 'getPath')）。
 */
function spawnEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function readJsonFile(path) {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeJsonFile(path, value) {
  ensureMonitorDir();
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readState() {
  return readJsonFile(STATE_FILE);
}

function patchState(patch) {
  try {
    writeJsonFile(STATE_FILE, { ...readState(), ...patch });
  } catch (error) {
    // 状态文件不可写（如沙箱权限抖动）不应中断守护/扫描主流程。
    warn(`状态文件写入失败（${error?.code ?? error?.message ?? error}），继续执行。`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJson(value) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// SQLite 加载（Node 22 可能需要 --experimental-sqlite，自动重试一次）
// ---------------------------------------------------------------------------

async function loadSqlite() {
  try {
    const mod = await import('node:sqlite');
    if (typeof mod.DatabaseSync === 'function') return mod.DatabaseSync;
  } catch (error) {
    if (process.env.YKT_MONITOR_REEXEC) throw error;
    info('node:sqlite 需要实验开关，正在带 --experimental-sqlite 重试。');
    const result = spawnSync(
      process.execPath,
      [
        '--experimental-sqlite',
        fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, YKT_MONITOR_REEXEC: '1' },
      },
    );
    process.exit(result.status ?? 1);
  }
  return fail('当前 Node 运行时不支持 node:sqlite。');
}

function dbCandidates() {
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return [
    process.env.YKT_LOG_DB,
    join(appData, '@ykt', 'desktop', 'storage', 'yuketang.sqlite'),
    join(appData, '雨课堂助手', 'storage', 'yuketang.sqlite'),
    join(appData, 'YuketangHelper', 'storage', 'yuketang.sqlite'),
  ].filter((value) => typeof value === 'string');
}

function resolveDbPath() {
  for (const candidate of dbCandidates()) {
    if (existsSync(candidate)) return candidate;
  }
  return fail(
    `未找到应用日志数据库，已检查：${dbCandidates().join('、')}。` +
      '可通过环境变量 YKT_LOG_DB 指定。',
  );
}

function openDatabase(path, DatabaseSync) {
  try {
    return new DatabaseSync(path, { readOnly: true });
  } catch {
    // WAL 热日志可能阻止只读打开；退回复用读写连接。
    return new DatabaseSync(path);
  }
}

/**
 * 数据库级运行时存活检测：minId 之后最后一条 runtime 日志为 started 且没有
 * 对应的 stopped，说明 Backend 仍在运行。作为窗口标题检测的稳健补充——
 * 标题依赖窗口可见性，在部分启动时序下可能延迟出现。
 */
async function maxLogId() {
  try {
    const DatabaseSync = await loadSqlite();
    const db = openDatabase(resolveDbPath(), DatabaseSync);
    try {
      const row = db.prepare('SELECT MAX(id) AS id FROM logs').get();
      return typeof row?.id === 'number' ? row.id : 0;
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

async function runtimeAliveAfter(minId) {
  try {
    const DatabaseSync = await loadSqlite();
    const db = openDatabase(resolveDbPath(), DatabaseSync);
    try {
      const row = db
        .prepare(
          "SELECT message FROM logs WHERE scope = 'runtime' AND id > ? ORDER BY id DESC LIMIT 1",
        )
        .get(minId);
      if (!row) return null;
      return String(row.message) === 'Backend runtime started.';
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 进程管理（Windows：按窗口标题识别桌面端进程）
// ---------------------------------------------------------------------------

function decodeTasklist(buffer) {
  const utf8 = buffer.toString('utf8');
  if (utf8.includes(APP_TITLE) || utf8.includes(ANSWER_WINDOW_TITLE)) {
    return utf8;
  }
  try {
    const gbk = new TextDecoder('gbk').decode(buffer);
    if (gbk.includes(APP_TITLE) || gbk.includes(ANSWER_WINDOW_TITLE)) {
      return gbk;
    }
  } catch {
    // 运行时不带 GBK 解码时保持 UTF-8 结果。
  }
  return utf8;
}

function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else quoted = false;
      } else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(current);
      current = '';
    } else current += char;
  }
  fields.push(current);
  return fields;
}

/**
 * 本工作区桌面端的 electron 可执行文件路径特征（ps -W 的 COMMAND 列）。
 * ps -W 只显示可执行文件路径、不显示参数，因此这里会同时命中主进程与
 * Renderer/GPU 子进程；子进程随主进程一起被 taskkill /t 结束。
 */
const APP_ELECTRON_MARKER =
  'ykt-helper-win\\node_modules\\electron\\dist\\electron.exe';

/** 候选映像名：开发态为 electron.exe，打包态为 Forge 配置的 executableName。 */
const APP_IMAGE_CANDIDATES = [
  'electron.exe',
  'YuketangHelper.exe',
  '雨课堂助手.exe',
];

const DESKTOP_DIR = join(PROJECT_ROOT, 'apps', 'desktop');
// 直接启动 electron.exe：.cmd 包装经 cmd.exe /c 传递时引号会被转义成 \"，
// 而 .exe 可以配合 spawn 的数组参数直接创建进程，不受路径空格影响。
const ELECTRON_EXE = join(
  PROJECT_ROOT,
  'node_modules',
  'electron',
  'dist',
  'electron.exe',
);
/** 启动后持续存活判定时间：短于崩溃循环（约 1-5 秒）退出窗口。 */
const START_VERIFY_SECONDS = 12;

/**
 * 启动策略序列。default 与 README 的 `npm start` 等价（electron . --）；
 * no-sandbox 用于本机 GPU 沙箱进程访问违规导致启动即退出的环境级回退，
 * 成功后记入 state.launchStrategy，后续启动优先复用。
 */
const LAUNCH_STRATEGIES = [
  { name: 'default', electronArgs: [] },
  { name: 'no-sandbox', electronArgs: ['--no-sandbox'] },
];

/** 按可执行文件路径匹配工作区实例（含子进程）。 */
function listAppProcessesByPath() {
  const result = spawnSync('ps', ['-W'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return [];
  const pids = [];
  for (const line of (result.stdout ?? '').split(/\r?\n/)) {
    if (!line.includes(APP_ELECTRON_MARKER)) continue;
    const columns = line.trim().split(/\s+/);
    const pid = Number.parseInt(columns[3] ?? '', 10);
    if (Number.isInteger(pid) && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

/** 按主窗口标题匹配进程（tasklist 必须按映像名过滤，否则全量枚举约需一分钟）。 */
function listAppProcessesByTitle() {
  const processes = [];
  for (const image of APP_IMAGE_CANDIDATES) {
    // 直接以数组参数调用：经过 cmd /c 包装时内层引号会被吞掉导致失败。
    // 映像名过滤是必需的：不带过滤器的 tasklist /v 会枚举所有进程的窗口信息，
    // 在本机耗时约一分钟。
    const result = spawnSync(
      'tasklist',
      ['/fi', `imagename eq ${image}`, '/v', '/fo', 'csv'],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0) continue;
    const lines = decodeTasklist(result.stdout).split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith('"')) continue;
      const columns = splitCsvLine(line);
      if (columns.length < 9) continue;
      const title = columns[8];
      if (title !== APP_TITLE && title !== ANSWER_WINDOW_TITLE) continue;
      const pid = Number.parseInt(columns[1], 10);
      if (Number.isInteger(pid)) {
        processes.push({ pid, title, image: columns[0] });
      }
    }
  }
  return processes;
}

/**
 * 仅按窗口标题定位主进程。只有主进程拥有“雨课堂助手”窗口，
 * Renderer/GPU 等子进程标题为 N/A，因此该结果是精确的。
 */
function findMainProcess() {
  return (
    listAppProcessesByTitle().find((item) => item.title === APP_TITLE) ?? null
  );
}

/** 列出桌面端相关进程：标题匹配 ∪ 路径匹配 ∪ 状态文件记录的 PID。 */
function listAppProcesses() {
  const merged = new Map();
  for (const item of listAppProcessesByTitle()) {
    merged.set(item.pid, item);
  }
  for (const pid of listAppProcessesByPath()) {
    if (!merged.has(pid)) {
      merged.set(pid, { pid, title: null, image: 'electron.exe' });
    }
  }
  const managed = readState().managedPid;
  if (typeof managed === 'number' && isPidAlive(managed)) {
    if (!merged.has(managed)) {
      merged.set(managed, { pid: managed, title: null, image: 'electron.exe' });
    }
  }
  return [...merged.values()].sort((left, right) => left.pid - right.pid);
}

function isPidAlive(pid) {
  const result = spawnSync('tasklist', ['/fi', `pid eq ${pid}`, '/fo', 'csv'], {
    encoding: 'utf8',
  });
  if (result.error) return false;
  const text = result.stdout ?? '';
  if (text.includes('No tasks')) return false;
  return text.includes(`"${pid}"`);
}

function appProcessPids() {
  return listAppProcesses().map((item) => item.pid);
}

async function stopApp(dryRun) {
  const pids = appProcessPids();
  if (pids.length === 0) {
    info('未发现正在运行的桌面端进程。');
    return { stopped: [], alreadyStopped: true };
  }
  info(`准备终止桌面端进程：${pids.join(', ')}`);
  if (dryRun) {
    return { stopped: [], wouldStop: pids, dryRun: true };
  }
  const stopped = [];
  for (const pid of pids) {
    const result = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      encoding: 'utf8',
    });
    if (result.status === 0) stopped.push(pid);
    else info(`taskkill PID ${pid} 退出码 ${result.status}：${result.stdout}`);
  }
  for (const pid of stopped) {
    for (let attempt = 0; attempt < 10 && isPidAlive(pid); attempt += 1) {
      await sleep(500);
    }
    if (isPidAlive(pid)) {
      info(`PID ${pid} 仍在运行，将在下次 stop 时重试。`);
    }
  }
  patchState({
    managedPid: null,
    lastStopAt: isoNow(),
    actionLockAt: isoNow(),
  });
  return { stopped, alreadyStopped: false };
}

/** 单次启动尝试：启动后必须持续存活 START_VERIFY_SECONDS 才算成功。 */
async function launchOnce(strategy, waitSeconds) {
  const logFile = join(
    MONITOR_DIR,
    `start-${fileStamp()}-${strategy.name}.log`,
  );
  ensureMonitorDir();
  const output = openSync(logFile, 'a');
  const args = [...strategy.electronArgs, '.', '--'];
  const child = spawn(ELECTRON_EXE, args, {
    cwd: DESKTOP_DIR,
    detached: true,
    stdio: ['ignore', output, output],
    windowsHide: true,
    env: spawnEnv(),
  });
  child.unref();
  info(
    `策略 ${strategy.name}：已按 detached 方式启动 electron.exe ${args.join(' ')}（cwd ${DESKTOP_DIR}），输出：${logFile}`,
  );
  // 记录启动前的日志 ID 水位线：只有新实例写入的 runtime 日志才被采信，
  // 避免陈旧实例的 started 记录造成误判。
  const idBefore = await maxLogId();
  const deadline = Date.now() + waitSeconds * 1000;
  let main = null;
  while (Date.now() < deadline) {
    await sleep(2000);
    main = findMainProcess();
    if (main) break;
    // 窗口标题可能延迟可见（启动时序/GPU 回退）；用数据库级运行时检测补充。
    // 运行时已明确停止（started 之后出现 stopped）= 启动即退出，快速失败，
    // 不必等满 waitSeconds。
    if ((await runtimeAliveAfter(idBefore)) === false) {
      await stopApp(false);
      return {
        started: false,
        strategy: strategy.name,
        reason: 'crashed-after-start',
        log: logFile,
      };
    }
  }
  // 初始判定：窗口标题优先；标题未出现但运行时已确认启动，按 runtime-log 采信。
  let via = main ? 'window' : null;
  if (!via && (await runtimeAliveAfter(idBefore)) === true) {
    via = 'runtime-log';
  }
  if (!via) {
    return {
      started: false,
      strategy: strategy.name,
      reason: 'not-started',
      log: logFile,
    };
  }
  // 持续存活验证。窗口标题检测存在间歇性失灵（任务栏标题查询偶发不返回），
  // 因此采用三信号或判：窗口标题 / 运行时日志 / 工作区 electron 进程存在；
  // 三者皆无才判定为启动后退出。
  await sleep(START_VERIFY_SECONDS * 1000);
  const windowAlive = findMainProcess() !== null;
  const runtimeAlive = (await runtimeAliveAfter(idBefore)) === true;
  const processesAlive = listAppProcessesByPath().length > 0;
  if (!windowAlive && !runtimeAlive && !processesAlive) {
    info(
      `策略 ${strategy.name}：启动后 ${START_VERIFY_SECONDS} 秒内所有存活信号均消失，判定为启动失败。`,
    );
    await stopApp(false);
    return {
      started: false,
      strategy: strategy.name,
      reason: 'crashed-after-start',
      pid: main?.pid ?? null,
      log: logFile,
    };
  }
  const pid = findMainProcess()?.pid ?? null;
  patchState({ managedPid: pid, lastStartAt: isoNow() });
  info(
    `桌面端已启动并持续存活（${windowAlive && pid ? `PID ${pid}` : '运行时/进程信号确认'}，策略 ${strategy.name}）。`,
  );
  return {
    started: true,
    strategy: strategy.name,
    pid,
    windowVerified: windowAlive,
    log: logFile,
  };
}

/** 策略顺序：上次成功的策略优先，其余按声明顺序兜底。 */
function orderedStrategies() {
  const preferred = readState().launchStrategy;
  const first = LAUNCH_STRATEGIES.filter(
    (strategy) => strategy.name === preferred,
  );
  const rest = LAUNCH_STRATEGIES.filter(
    (strategy) => strategy.name !== preferred,
  );
  return [...first, ...rest];
}

/**
 * 启动尝试（不输出 JSON、不退出进程，供 start / guard 复用）。
 * 返回 { started, strategy?, pid?, attempts, error? }。
 */
async function attemptStart({ waitSeconds, force }) {
  if (!existsSync(DIST_ENTRY)) {
    return {
      started: false,
      attempts: [],
      error: `未找到 ${DIST_ENTRY}，请先在仓库根目录执行 npm run build。`,
    };
  }
  if (!existsSync(ELECTRON_EXE)) {
    return {
      started: false,
      attempts: [],
      error: `未找到 ${ELECTRON_EXE}，请先在仓库根目录执行 npm ci。`,
    };
  }
  const main = findMainProcess();
  if (main && !force) {
    return { started: true, alreadyRunning: true, pid: main.pid, attempts: [] };
  }
  // 清理可能残留的子进程，避免单实例锁与资源占用。
  await stopApp(false);
  const attempts = [];
  for (const strategy of orderedStrategies()) {
    const result = await launchOnce(strategy, waitSeconds);
    attempts.push({
      strategy: strategy.name,
      started: result.started,
      ...(result.started ? {} : { reason: result.reason }),
    });
    if (result.started) {
      patchState({ launchStrategy: strategy.name, actionLockAt: null });
      return {
        started: true,
        strategy: strategy.name,
        pid: result.pid,
        log: result.log,
        attempts,
      };
    }
  }
  return {
    started: false,
    attempts,
    error:
      `所有启动策略均失败：${attempts
        .map((attempt) => `${attempt.strategy}(${attempt.reason ?? 'ok'})`)
        .join(', ')}。请检查 logs/monitor/start-*.log；` +
      '若为 GPU 进程崩溃，可能需要更新显卡驱动或禁用虚拟显示器后重试。',
  };
}

async function startApp(options) {
  const { dryRun, waitSeconds, force } = options;
  if (dryRun) {
    return emitJson({
      command: 'start',
      started: false,
      wouldStart: true,
      dryRun: true,
      strategies: orderedStrategies().map((strategy) => strategy.name),
    });
  }
  const result = await attemptStart({ waitSeconds, force });
  if (!result.started) return fail(result.error);
  return emitJson({ command: 'start', ...result });
}

// ---------------------------------------------------------------------------
// 日志扫描与复发判定
// ---------------------------------------------------------------------------

function collectSignals(entries, inWindow, processRunning) {
  const signals = [];

  const push = (id, severity, title, evidence) => {
    if (evidence.length === 0) return;
    signals.push({
      id,
      severity,
      title,
      count: evidence.length,
      evidence: evidence.slice(0, 5),
    });
  };

  // H1 题目事件绑定受阻：等待课件绑定后未能在宽限时间内完成绑定。
  // 修复后的链路会在 unlock 事件发生时按事件课件 ID 立即补取并绑定；
  // 长时间“等待绑定”或同一题目反复等待即视为课件归属/补取逻辑回归。
  const waitsByProblem = new Map();
  for (const entry of inWindow) {
    if (entry.message !== '题目事件等待课件绑定。') continue;
    const problemId = asString(entry.details.problemId) ?? 'unknown';
    waitsByProblem.set(problemId, [
      ...(waitsByProblem.get(problemId) ?? []),
      entry,
    ]);
  }
  const bindsByProblem = new Map();
  for (const entry of inWindow) {
    if (!BIND_SUCCESS_MESSAGES.has(entry.message)) continue;
    const problemId = asString(entry.details.problemId);
    if (!problemId) continue;
    bindsByProblem.set(problemId, [
      ...(bindsByProblem.get(problemId) ?? []),
      entry,
    ]);
  }
  const stuckBinds = [];
  for (const [problemId, waits] of waitsByProblem) {
    const lastWait = waits[waits.length - 1];
    const bindsAfter = (bindsByProblem.get(problemId) ?? []).filter(
      (entry) => Date.parse(entry.timestamp) > Date.parse(lastWait.timestamp),
    );
    const graceMs = BIND_GRACE_MINUTES * 60 * 1000;
    const firstBind = bindsAfter[0];
    const boundWithinGrace =
      firstBind !== undefined &&
      Date.parse(firstBind.timestamp) - Date.parse(lastWait.timestamp) <=
        graceMs;
    if (boundWithinGrace) continue;
    stuckBinds.push({
      problemId,
      lessonId: lastWait.details.lessonId ?? null,
      waits: waits.length,
      lastWaitAt: lastWait.timestamp,
      boundAt: firstBind?.timestamp ?? null,
      reason: lastWait.details.reason ?? null,
    });
  }
  push(
    'H1',
    'high',
    `题目事件等待课件绑定后超过 ${BIND_GRACE_MINUTES} 分钟未绑定（课件归属/补取回归）`,
    stuckBinds,
  );

  // H2 题目事件完全无法绑定。
  push(
    'H2',
    'high',
    '官方题目事件无法绑定',
    inWindow
      .filter((entry) => entry.message === '官方题目事件无法绑定。')
      .map((entry) => ({
        at: entry.timestamp,
        lessonId: entry.details.lessonId ?? null,
        problemId: entry.details.problemId ?? null,
        reason: entry.details.reason ?? null,
      })),
  );

  // H3 按题目事件补取课件持续失败。
  const refetchByKey = new Map();
  for (const entry of inWindow) {
    if (entry.message !== '按题目事件补取课件失败。') continue;
    const key = `${String(entry.details.lessonId ?? '')}:${String(
      entry.details.presentationId ?? '',
    )}`;
    refetchByKey.set(key, [...(refetchByKey.get(key) ?? []), entry]);
  }
  for (const [key, group] of refetchByKey) {
    if (group.length < 2) continue;
    push('H3', 'high', '按题目事件补取课件持续失败', [
      {
        key,
        count: group.length,
        first: group[0].timestamp,
        last: group[group.length - 1].timestamp,
        error: group[group.length - 1].details.error ?? null,
      },
    ]);
  }

  // H4 同一课堂的结束事件在监控窗口内重复（生命周期清理去重失效）。
  // 结束事件可能早于监控窗口，因此只统计窗口内的重复；窗口外的历史重复
  // 由当时的扫描承担，避免同一证据被反复上报。
  const endsInWindow = new Map();
  for (const entry of inWindow) {
    if (entry.message !== '课堂已结束，已停止监听。') continue;
    const lessonId = asString(entry.details.lessonId) ?? 'unknown';
    endsInWindow.set(lessonId, [...(endsInWindow.get(lessonId) ?? []), entry]);
  }
  for (const [lessonId, group] of endsInWindow) {
    if (group.length < 2) continue;
    push('H4', 'high', '同一课堂结束事件重复（生命周期清理回归）', [
      {
        lessonId,
        count: group.length,
        first: group[0].timestamp,
        last: group[group.length - 1].timestamp,
      },
    ]);
  }

  // H5/H6 需要课堂结束时刻；结束事件可能早于监控窗口，因此在全量日志中取
  // 每个课堂最后一次结束时间作为基准。
  const lessonEnds = new Map();
  for (const entry of entries) {
    if (entry.message !== '课堂已结束，已停止监听。') continue;
    const lessonId = asString(entry.details.lessonId) ?? 'unknown';
    lessonEnds.set(lessonId, [...(lessonEnds.get(lessonId) ?? []), entry]);
  }
  const endedAt = new Map();
  for (const [lessonId, group] of lessonEnds) {
    endedAt.set(lessonId, Date.parse(group[group.length - 1].timestamp));
  }

  // H5 课堂结束之后仍产生该课堂的事件（切换未跟随 / 监听未释放）。
  // 回顾页课件（presentationId 以 report- 开头）由课堂结束后的回顾同步流程
  // 收集，属于设计内行为，不计入本信号；其余课堂事件仍照常判定。
  const eventsAfterEnd = [];
  for (const entry of inWindow) {
    if (!CLASSROOM_EVENT_MESSAGES.has(entry.message)) continue;
    const lessonId = asString(entry.details.lessonId);
    if (!lessonId) continue;
    if (
      entry.message === '已从官方页面收集课件。' &&
      (asString(entry.details.presentationId) ?? '').startsWith(
        REVIEW_PRESENTATION_PREFIX,
      )
    ) {
      continue;
    }
    const end = endedAt.get(lessonId);
    if (end === undefined) continue;
    if (Date.parse(entry.timestamp) > end) {
      eventsAfterEnd.push({
        at: entry.timestamp,
        lessonId,
        message: entry.message,
        problemId: entry.details.problemId ?? null,
      });
    }
  }
  push(
    'H5',
    'high',
    '课堂结束后仍产生课堂事件（切换未跟随/监听未释放）',
    eventsAfterEnd,
  );

  // H6 课堂结束之后仍进入自动答题流水线。
  const autoAfterEnd = [];
  for (const entry of inWindow) {
    if (entry.scope !== 'automation') continue;
    const stage = asString(entry.details.stage);
    if (!stage || !AUTOMATION_ACTIVE_STAGES.has(stage)) continue;
    const lessonId = asString(entry.details.lessonId);
    if (!lessonId) continue;
    const end = endedAt.get(lessonId);
    if (end === undefined) continue;
    if (Date.parse(entry.timestamp) > end) {
      autoAfterEnd.push({
        at: entry.timestamp,
        lessonId,
        problemId: entry.details.problemId ?? null,
        stage,
      });
    }
  }
  push('H6', 'high', '课堂结束后仍排队自动答题（旧任务未取消）', autoAfterEnd);

  // H7 回顾页习题自动答题失败。
  push(
    'H7',
    'high',
    '回顾页习题自动答题失败',
    inWindow
      .filter(
        (entry) =>
          entry.message === '自动答题失败，本轮不会重新排队。' &&
          entry.details.report === true,
      )
      .map((entry) => ({
        at: entry.timestamp,
        lessonId: entry.details.lessonId ?? null,
        problemId: entry.details.problemId ?? null,
        reason: entry.details.reason ?? null,
      })),
  );

  // H8 回顾页补交（retry 路由）请求失败。
  push(
    'H8',
    'high',
    '回顾页补交请求失败',
    inWindow
      .filter(
        (entry) =>
          entry.message === '答案请求失败。' && entry.details.route === 'retry',
      )
      .map((entry) => ({
        at: entry.timestamp,
        lessonId: entry.details.lessonId ?? null,
        problemId: entry.details.problemId ?? null,
        error: entry.details.error ?? null,
      })),
  );

  // H9 同一题目连续提交失败且无成功间隔。
  const submitEntries = inWindow
    .filter(
      (entry) =>
        entry.scope === 'answer-request' &&
        (entry.message === '答案请求失败。' ||
          entry.message === '答案请求已被服务端接受。'),
    )
    .sort((left, right) => left.id - right.id);
  const streakByProblem = new Map();
  const streakStart = new Map();
  for (const entry of submitEntries) {
    const problemId = asString(entry.details.problemId) ?? 'unknown';
    if (entry.message === '答案请求已被服务端接受。') {
      streakByProblem.set(problemId, 0);
      continue;
    }
    const streak = (streakByProblem.get(problemId) ?? 0) + 1;
    streakByProblem.set(problemId, streak);
    if (!streakStart.has(problemId))
      streakStart.set(problemId, entry.timestamp);
  }
  const streaks = [];
  for (const [problemId, streak] of streakByProblem) {
    if (streak < 3) continue;
    streaks.push({
      problemId,
      consecutiveFailures: streak,
      firstFailureAt: streakStart.get(problemId) ?? null,
    });
  }
  push('H9', 'high', '同一题目连续提交失败（提交链路回归）', streaks);

  // M1 课堂凭据刷新失败。
  push(
    'M1',
    'medium',
    '课堂凭据刷新失败',
    inWindow
      .filter((entry) => entry.message === '课堂凭据刷新失败，未重试提交。')
      .map((entry) => ({
        at: entry.timestamp,
        lessonId: entry.details.lessonId ?? null,
        problemId: entry.details.problemId ?? null,
        error: entry.details.error ?? null,
      })),
  );

  // M2 课堂数据解析失败（观察链路错投/解析回归）。
  const collectionErrors = inWindow.filter(
    (entry) => entry.message === '官方课堂数据解析失败。',
  );
  if (collectionErrors.length >= 2) {
    push('M2', 'medium', '官方课堂数据解析失败（观察链路异常）', [
      {
        count: collectionErrors.length,
        first: collectionErrors[0].timestamp,
        last: collectionErrors[collectionErrors.length - 1].timestamp,
      },
    ]);
  }

  // M3 自动签到轮询停滞（进程存活但长时间无课堂列表刷新）。
  const refreshes = entries.filter(
    (entry) => entry.message === '课堂列表已刷新。',
  );
  const lastRefreshAt = refreshes[refreshes.length - 1]?.timestamp ?? null;
  if (
    processRunning &&
    refreshes.length >= 2 &&
    lastRefreshAt !== null &&
    Date.now() - Date.parse(lastRefreshAt) > POLL_STALL_MINUTES * 60 * 1000
  ) {
    push('M3', 'medium', '课堂列表轮询停滞（应用疑似卡死）', [
      {
        lastRefreshAt,
        processRunning: true,
      },
    ]);
  }

  // M4 应用进程已退出，但不久前仍有日志活动（疑似崩溃而非手动关闭）。
  // 手动关闭时最后一次刷新会随时间自然老化，该信号只触发一次；
  // 是否唤活由执行体结合 process.appExitedCleanly 判断。
  if (
    !processRunning &&
    refreshes.length > 0 &&
    lastRefreshAt !== null &&
    Date.now() - Date.parse(lastRefreshAt) <
      APP_DEATH_WINDOW_MINUTES * 60 * 1000
  ) {
    push('M4', 'medium', '应用进程已退出但最近仍有日志活动（疑似崩溃）', [
      {
        lastRefreshAt,
        processRunning: false,
      },
    ]);
  }

  return signals;
}

function decideStatus(signals) {
  const high = signals.filter((signal) => signal.severity === 'high').length;
  const medium = signals.filter(
    (signal) => signal.severity === 'medium',
  ).length;
  if (high > 0) return 'recurrence';
  if (medium >= 2) return 'recurrence';
  if (medium === 1) return 'warning';
  return 'ok';
}

async function cmdScan(options) {
  const dbPath = resolveDbPath();
  const windowHours = Number.parseFloat(options.get('window-hours') ?? '2');
  const state = readState();
  const now = Date.now();
  const sinceOverride = options.get('since');
  const since = sinceOverride
    ? Date.parse(sinceOverride)
    : state.lastScanAt
      ? Date.parse(String(state.lastScanAt))
      : now - (Number.isFinite(windowHours) ? windowHours : 2) * 60 * 60 * 1000;
  if (!Number.isFinite(since)) {
    return fail(
      `无法解析扫描起点：${sinceOverride ?? String(state.lastScanAt)}`,
    );
  }

  let DatabaseSync;
  try {
    DatabaseSync = await loadSqlite();
  } catch (error) {
    return fail(`加载 node:sqlite 失败：${String(error)}`);
  }
  let db;
  try {
    db = openDatabase(dbPath, DatabaseSync);
  } catch (error) {
    return fail(`打开日志数据库失败：${String(error)}`);
  }
  let rows;
  try {
    rows = db
      .prepare(
        'SELECT id, timestamp, level, scope, message, details FROM logs ORDER BY id DESC LIMIT ?',
      )
      .all(LOG_RETENTION_LIMIT);
  } catch (error) {
    return fail(`读取日志失败：${String(error)}`);
  } finally {
    db.close();
  }
  const entries = rows
    .map((row) => ({
      id: Number(row.id),
      timestamp: String(row.timestamp),
      level: String(row.level),
      scope: String(row.scope),
      message: String(row.message),
      details: safeJson(row.details),
    }))
    .sort((left, right) => left.id - right.id);
  const inWindow = entries.filter(
    (entry) => Date.parse(entry.timestamp) >= since,
  );
  const processes = listAppProcesses();
  const signals = collectSignals(entries, inWindow, processes.length > 0);
  const status = decideStatus(signals);

  const byScope = new Map();
  for (const entry of inWindow) {
    byScope.set(entry.scope, (byScope.get(entry.scope) ?? 0) + 1);
  }
  const lastRefresh = [...entries]
    .reverse()
    .find((entry) => entry.message === '课堂列表已刷新。');

  // 区分“用户手动关闭”与“崩溃/被 kill”（仅在进程未运行时判定）：
  // 最后一次课堂轮询之后，最后一条 runtime 日志是 stopped → 干净退出；
  // 是 started 或没有任何 runtime 日志（被强杀）→ 非正常退出。
  // 无轮询历史时无法判定，保持 null。
  let appExitedCleanly = null;
  if (processes.length === 0 && lastRefresh) {
    const runtimeAfter = entries
      .filter((entry) => entry.scope === 'runtime' && entry.id > lastRefresh.id)
      .reverse();
    const latest = runtimeAfter[0];
    appExitedCleanly = latest
      ? latest.message === 'Backend runtime stopped.'
      : false;
  }

  patchState({
    lastScanAt: isoNow(),
    lastVerdict: status,
    lastSignalIds: signals.map((signal) => signal.id),
    lastScanWindow: { from: new Date(since).toISOString(), to: isoNow() },
  });

  emitJson({
    command: 'scan',
    status,
    dbPath,
    window: { from: new Date(since).toISOString(), to: isoNow() },
    process: {
      running: processes.length > 0,
      pids: processes.map((item) => item.pid),
      appExitedCleanly,
      // 常驻策略：应用应在任何时候保持运行，未运行即需要唤活。
      // appExitedCleanly 仅作诊断信息，不再作为是否唤活的条件。
      needsRevive: processes.length === 0,
    },
    stats: {
      totalEntries: entries.length,
      entriesInWindow: inWindow.length,
      byScope: Object.fromEntries([...byScope].sort()),
      lastRefreshAt: lastRefresh?.timestamp ?? null,
    },
    signals,
    nextStep:
      status === 'recurrence'
        ? '执行临时修复：stop → start；随后定位并正式修复代码，验证后再次 stop → start。'
        : processes.length === 0
          ? '应用未运行：按常驻策略用后台守护方式启动（start && await-exit）。'
          : '无需处置，记录本次结果即可。',
  });
  if (status === 'recurrence') process.exitCode = 10;
}

// ---------------------------------------------------------------------------
// status / restart / record
// ---------------------------------------------------------------------------

function cmdStatus() {
  const processes = listAppProcesses();
  const state = readState();
  const dbPath =
    dbCandidates().find((candidate) => existsSync(candidate)) ?? null;
  const managedPid = state.managedPid;
  emitJson({
    command: 'status',
    process: {
      running: processes.length > 0,
      processes,
      managedPid:
        typeof managedPid === 'number' && isPidAlive(managedPid)
          ? managedPid
          : null,
    },
    monitor: {
      stateFile: STATE_FILE,
      dbPath,
      lastScanAt: state.lastScanAt ?? null,
      lastVerdict: state.lastVerdict ?? null,
      lastSignalIds: state.lastSignalIds ?? [],
      lastStartAt: state.lastStartAt ?? null,
      lastStopAt: state.lastStopAt ?? null,
    },
  });
}

/**
 * 守护进程：持续运行直到桌面端退出。
 *
 * 宿主环境会在命令结束时终止其进程树（包括 detached 子进程），因此启动应用
 * 必须以“start && await-exit”的形式放在长驻后台任务里：本命令不退出，
 * 应用就始终有存活的长辈进程，命令结束时的树终止就不会波及它。
 */
async function cmdAwaitExit() {
  if (listAppProcesses().length === 0) {
    info('await-exit：当前没有运行中的桌面端进程，立即返回。');
    emitJson({ command: 'await-exit', waitedFor: null, reason: 'not-running' });
    return;
  }
  const started = Date.now();
  info('await-exit：开始守护桌面端进程，应用退出后本命令返回。');
  while (listAppProcesses().length > 0) {
    await sleep(15_000);
  }
  const waitedMs = Date.now() - started;
  info(`await-exit：桌面端已退出，守护 ${Math.round(waitedMs / 1000)} 秒。`);
  patchState({ managedPid: null });
  emitJson({ command: 'await-exit', waitedMs });
}

/**
 * 常驻守护循环：每 30 秒检查一次，应用未运行（连续两次确认）且没有监控动作
 * 正在进行时立即唤活。心跳文件记录守护自身 PID：只有“进程存活且心跳新鲜”
 * 才视为已有守护，避免死守护的陈旧心跳阻止新守护接管。
 */
function guardOwner() {
  try {
    if (!existsSync(GUARD_HEARTBEAT_FILE)) return null;
    const parsed = JSON.parse(
      readFileSync(GUARD_HEARTBEAT_FILE, 'utf8').trim(),
    );
    return typeof parsed?.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

function guardAlive() {
  const owner = guardOwner();
  if (!owner) return false;
  const fresh =
    typeof owner.at === 'string' &&
    Date.now() - Date.parse(owner.at) < GUARD_HEARTBEAT_TTL_MS;
  return fresh && isPidAlive(owner.pid);
}

let heartbeatWriteFailed = false;

function writeGuardHeartbeat() {
  try {
    ensureMonitorDir();
    writeFileSync(
      GUARD_HEARTBEAT_FILE,
      `${JSON.stringify({ pid: process.pid, at: isoNow() })}\n`,
      'utf8',
    );
    heartbeatWriteFailed = false;
  } catch (error) {
    // 心跳写不进去时守护仍必须继续看护应用；只提示一次，避免每轮刷屏。
    if (!heartbeatWriteFailed) {
      heartbeatWriteFailed = true;
      warn(
        `心跳文件写入失败（${error?.code ?? error?.message ?? error}），守护继续运行；` +
          `期间新执行的 guard 可能重复接管（唤活前会检测应用是否已在运行，无副作用）。`,
      );
    }
  }
}

/** 监控动作锁：stop 写入、启动成功后清除；守护在锁有效期内不打断动作。 */
function actionLockActive() {
  const at = readState().actionLockAt;
  if (typeof at !== 'string') return false;
  const parsed = Date.parse(at);
  return (
    Number.isFinite(parsed) &&
    Date.now() - parsed < ACTION_LOCK_MINUTES * 60_000
  );
}

async function cmdGuard() {
  if (guardAlive()) {
    info('guard：常驻守护已在运行，本命令立即返回。');
    emitJson({ command: 'guard', guarded: true });
    return;
  }
  info('guard：未发现存活的常驻守护，开始守护循环（30 秒间隔）。');
  emitJson({ command: 'guard', guarded: false, started: true });
  let downSince = null;
  let lastAttemptAt = 0;
  while (true) {
    try {
      writeGuardHeartbeat();
      if (listAppProcesses().length > 0) {
        downSince = null;
      } else if (downSince === null) {
        downSince = Date.now();
        info('guard：检测到应用未运行，等待下一次检查确认。');
      } else if (
        !actionLockActive() &&
        Date.now() - lastAttemptAt > GUARD_INTERVAL_MS * 2
      ) {
        lastAttemptAt = Date.now();
        info('guard：应用持续未运行，执行唤活。');
        const result = await attemptStart({ waitSeconds: 90, force: false });
        patchState({ lastGuardReviveAt: isoNow() });
        info(
          result.started
            ? result.alreadyRunning
              ? 'guard：唤活时应用已在运行。'
              : `guard：唤活成功（${result.strategy}${result.pid ? `，PID ${result.pid}` : ''}）。`
            : `guard：唤活失败：${result.error}`,
        );
        downSince = result.started ? null : Date.now();
      }
    } catch (error) {
      // 单轮异常（权限抖动、进程查询失败等）绝不终止守护，否则应用将无人看管。
      warn(`guard：本轮检查异常（${error?.message ?? error}），30 秒后重试。`);
    }
    await sleep(GUARD_INTERVAL_MS);
  }
}

async function cmdRestart(options) {
  const dryRun = options.get('dry-run') === 'true';
  const waitSeconds = Number.parseInt(options.get('wait-seconds') ?? '90', 10);
  const stopped = await stopApp(dryRun);
  const started = dryRun
    ? { skipped: true, reason: 'dry-run' }
    : await startApp({ dryRun: false, waitSeconds, force: false });
  emitJson({ command: 'restart', stopped, started });
}

function safeJsonOrRaw(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function cmdRecord(options) {
  const status = options.get('status');
  if (!status) {
    return fail('record 需要 --status <ok|recurrence|fixed|failed>。');
  }
  const summary = options.get('summary') ?? '';
  const details = safeJsonOrRaw(options.get('details'));
  const signals = (options.get('signals') ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  ensureMonitorDir();
  const record = {
    at: isoNow(),
    status,
    summary,
    signals,
    details,
  };
  const localDate = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
  const file = join(MONITOR_DIR, `monitor-${localDate}.jsonl`);
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  patchState({
    lastRunAt: record.at,
    lastRunStatus: status,
    lastRunSummary: summary,
  });
  emitJson({ command: 'record', file, record });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command] = positionals;
  switch (command) {
    case 'scan':
      return await cmdScan(options);
    case 'status':
      return cmdStatus();
    case 'stop':
      return emitJson({
        command: 'stop',
        ...(await stopApp(options.get('dry-run') === 'true')),
      });
    case 'start':
      return await startApp({
        dryRun: options.get('dry-run') === 'true',
        waitSeconds: Number.parseInt(options.get('wait-seconds') ?? '90', 10),
        force: options.get('force') === 'true',
      });
    case 'restart':
      return await cmdRestart(options);
    case 'await-exit':
      return await cmdAwaitExit();
    case 'guard':
      return await cmdGuard();
    case 'record':
      return cmdRecord(options);
    default:
      return fail(
        '用法：node scripts/log-monitor.mjs <scan|status|stop|start|restart|await-exit|guard|record> [选项]',
      );
  }
}

await main();

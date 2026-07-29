"use strict";
const electron = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const events = require("events");
const promises = require("dns/promises");
const yaml = require("js-yaml");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const dgram = require("dgram");
const http = require("http");
const https = require("https");
const url = require("url");
const child_process = require("child_process");
const pty = require("node-pty");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
const is = {
  dev: !electron.app.isPackaged
};
const platform = {
  isWindows: process.platform === "win32",
  isMacOS: process.platform === "darwin",
  isLinux: process.platform === "linux"
};
const electronApp = {
  setAppUserModelId(id) {
    if (platform.isWindows)
      electron.app.setAppUserModelId(is.dev ? process.execPath : id);
  },
  setAutoLaunch(auto) {
    if (platform.isLinux)
      return false;
    const isOpenAtLogin = () => {
      return electron.app.getLoginItemSettings().openAtLogin;
    };
    if (isOpenAtLogin() !== auto) {
      electron.app.setLoginItemSettings({
        openAtLogin: auto,
        path: process.execPath
      });
      return isOpenAtLogin() === auto;
    } else {
      return true;
    }
  },
  skipProxy() {
    return electron.session.defaultSession.setProxy({ mode: "direct" });
  }
};
const isMac = process.platform === "darwin";
function createMainWindow(savedBounds) {
  const win = new electron.BrowserWindow({
    width: savedBounds?.width ?? 1100,
    height: savedBounds?.height ?? 700,
    x: savedBounds?.x,
    y: savedBounds?.y,
    minWidth: 800,
    minHeight: 500,
    show: false,
    icon: path.join(__dirname, "../../resources/icon-256.png"),
    backgroundColor: "#0a0a0a",
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    ...isMac ? {} : {
      titleBarOverlay: {
        color: "#0a0a0a",
        symbolColor: "#a1a1aa",
        height: 40
      }
    },
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.on("ready-to-show", () => {
    win.show();
  });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return win;
}
function createOverlayWindow() {
  const { width: screenW } = electron.screen.getPrimaryDisplay().workAreaSize;
  const win = new electron.BrowserWindow({
    width: 440,
    height: 52,
    x: screenW - 440,
    y: 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/overlay.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"] + "/overlay.html");
  } else {
    win.loadFile(path.join(__dirname, "../renderer/overlay.html"));
  }
  return win;
}
const basePath = path.join(__dirname, "../../resources");
function loadIcon(names) {
  for (const name of names) {
    const p = path.join(basePath, name);
    if (fs.existsSync(p)) {
      try {
        const buf = fs.readFileSync(p);
        const img = electron.nativeImage.createFromBuffer(buf);
        if (!img.isEmpty()) return img;
      } catch {
      }
    }
  }
  return electron.nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAh0lEQVR4nO2UUQrAIAxD3dgFdieP7Z08wvY1EMHR2JQxTH7V+mjTpCStrm10UHO+PIXPUoa1W+2eTxgSwGG9aJ3po9ZDb28/74AAzB5A9ZscUBIKwJ2EvVfQxHR3oP8QNS9lBB4ImgdmIagmnIGgbwEKEbKGCERYDlghQoPIAhGehGgwSevpBgrkNl2U/9ihAAAAAElFTkSuQmCC"
  );
}
let templateIcon = null;
let recIcon = null;
let pausedIcon = null;
function getTemplateIcon() {
  if (!templateIcon) {
    templateIcon = loadIcon(["tray-iconTemplate@2x.png", "tray-iconTemplate.png"]);
    templateIcon.setTemplateImage(true);
  }
  return templateIcon;
}
function getRecIcon() {
  if (!recIcon) {
    recIcon = loadIcon(["tray-icon-rec@2x.png", "tray-icon-rec.png"]);
    recIcon.setTemplateImage(false);
  }
  return recIcon;
}
function getPausedIcon() {
  if (!pausedIcon) {
    pausedIcon = loadIcon(["tray-icon-paused@2x.png", "tray-icon-paused.png"]);
    pausedIcon.setTemplateImage(false);
  }
  return pausedIcon;
}
function setTrayRecording(tray2, recording) {
  if (recording === null) {
    tray2.setImage(getTemplateIcon());
    tray2.setTitle("");
    tray2.setToolTip("RedLog — Red Team Operation Log");
    return;
  }
  if (recording) {
    tray2.setImage(getRecIcon());
    tray2.setTitle(" REC", { fontType: "monospacedDigit" });
    tray2.setToolTip("RedLog — Recording");
  } else {
    tray2.setImage(getPausedIcon());
    tray2.setTitle(" PAUSED", { fontType: "monospacedDigit" });
    tray2.setToolTip("RedLog — Paused");
  }
}
function createTray(mainWindow2, overlayWindow2, onToggleRecording, onQuickMark) {
  const tray2 = new electron.Tray(getTemplateIcon());
  const buildMenu = (recording) => {
    const items = [
      {
        label: "Show RedLog",
        click: () => {
          mainWindow2.show();
          mainWindow2.focus();
        }
      }
    ];
    if (onQuickMark) {
      items.push({
        label: "⚑ Quick Mark",
        accelerator: "CommandOrControl+Shift+M",
        click: () => onQuickMark()
      });
    }
    if (onToggleRecording) {
      items.push({
        label: recording ? "⏸ Pause Recording" : "⏺ Resume Recording",
        click: () => {
          const newState = onToggleRecording();
          setTrayRecording(tray2, newState);
          buildMenu(newState);
        }
      });
    }
    items.push({
      label: "Toggle HUD",
      click: () => {
        if (!overlayWindow2) return;
        if (overlayWindow2.isVisible()) {
          overlayWindow2.hide();
        } else {
          overlayWindow2.show();
        }
        mainWindow2.webContents.send("overlay:visibilityChanged", overlayWindow2.isVisible());
      }
    });
    items.push({ type: "separator" });
    items.push({ label: "Quit", role: "quit" });
    tray2.setContextMenu(electron.Menu.buildFromTemplate(items));
  };
  buildMenu();
  tray2.on("click", () => {
    mainWindow2.show();
    mainWindow2.focus();
  });
  return tray2;
}
const DNS_LOOKUPS = [
  { server: "208.67.222.222", host: "myip.opendns.com", type: "A" },
  // OpenDNS resolver1
  { server: "216.239.32.10", host: "o-o.myaddr.l.google.com", type: "TXT" }
  // Google ns1
];
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
async function getExternalIPviaDNS() {
  for (const q of DNS_LOOKUPS) {
    try {
      const resolver = new promises.Resolver({ timeout: 3e3, tries: 1 });
      resolver.setServers([q.server]);
      if (q.type === "A") {
        const ips = await resolver.resolve4(q.host);
        const ip = ips.find((s) => IPV4_RE.test(s));
        if (ip) return ip;
      } else {
        const rows = await resolver.resolveTxt(q.host);
        const ip = rows?.[0]?.join("").replace(/"/g, "").trim();
        if (ip && IPV4_RE.test(ip)) return ip;
      }
    } catch {
    }
  }
  throw new Error("All DNS resolvers failed");
}
const DEFAULT_IP_PROVIDERS = [
  "https://api.ipify.org?format=json",
  "https://ipinfo.io/json",
  "https://api.my-ip.io/v2/ip.json"
];
const DEFAULT_CONFIRMATIONS = 3;
function ipToLong$1(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + parseInt(octet), 0) >>> 0;
}
function ipInCIDR(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  const [network, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  return (ipToLong$1(ip) & mask) === (ipToLong$1(network) & mask);
}
function getInternalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}
async function getExternalIPviaHTTP(providers) {
  for (const url2 of providers) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5e3);
      const res = await fetch(url2, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) continue;
      const data = await res.json();
      return data.ip ?? data.origin ?? String(data);
    } catch {
      continue;
    }
  }
  throw new Error("All IP providers failed");
}
class IPMonitor extends events.EventEmitter {
  constructor() {
    super(...arguments);
    this.interval = null;
    this.whitelist = [];
    this.blacklist = [];
    this.checkIntervalMs = 1e4;
    this.providers = [...DEFAULT_IP_PROVIDERS];
    this.confirmations = DEFAULT_CONFIRMATIONS;
    this.ipMode = "auto";
    this.pendingIP = null;
    this.pendingCount = 0;
    this._status = {
      externalIP: null,
      internalIP: null,
      ipSafety: "unknown",
      lastCheck: 0,
      error: null,
      settling: false
    };
  }
  get status() {
    return { ...this._status };
  }
  configure(opts) {
    if (opts.whitelist) this.whitelist = opts.whitelist;
    if (opts.blacklist) this.blacklist = opts.blacklist;
    if (opts.checkInterval) this.checkIntervalMs = opts.checkInterval * 1e3;
    if (opts.providers?.length) this.providers = opts.providers;
    if (typeof opts.confirmations === "number" && opts.confirmations > 0) {
      this.confirmations = opts.confirmations;
    }
    if (opts.ipMode) this.ipMode = opts.ipMode;
  }
  // Fetch the external IP per the configured mode. 'auto' prefers the quiet DNS
  // path and only falls back to HTTP when DNS is unavailable/blocked.
  fetchExternalIP() {
    if (this.ipMode === "dns") return getExternalIPviaDNS();
    if (this.ipMode === "http") return getExternalIPviaHTTP(this.providers);
    return getExternalIPviaDNS().catch(() => getExternalIPviaHTTP(this.providers));
  }
  classify(ip) {
    if (this.blacklist.length > 0 && this.blacklist.some((cidr) => ipInCIDR(ip, cidr))) return "exposed";
    if (this.whitelist.length > 0 && this.whitelist.some((cidr) => ipInCIDR(ip, cidr))) return "safe";
    if (this.blacklist.length > 0) return "safe";
    return "unknown";
  }
  start() {
    this.check();
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
  }
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
  async check() {
    try {
      const [externalIP, internalIP] = await Promise.all([
        this.fetchExternalIP(),
        Promise.resolve(getInternalIP())
      ]);
      const settled = this._status.externalIP;
      if (externalIP === settled) {
        this.pendingIP = null;
        this.pendingCount = 0;
        this._status = {
          ...this._status,
          internalIP,
          lastCheck: Date.now(),
          error: null,
          settling: false
        };
      } else {
        this.pendingCount = externalIP === this.pendingIP ? this.pendingCount + 1 : 1;
        this.pendingIP = externalIP;
        const promote = settled === null || this.pendingCount >= this.confirmations;
        if (promote) {
          this.pendingIP = null;
          this.pendingCount = 0;
          this._status = {
            externalIP,
            internalIP,
            ipSafety: this.classify(externalIP),
            lastCheck: Date.now(),
            error: null,
            settling: false
          };
        } else {
          this._status = {
            ...this._status,
            internalIP,
            lastCheck: Date.now(),
            error: null,
            settling: true
          };
        }
      }
    } catch (err) {
      this._status = {
        ...this._status,
        lastCheck: Date.now(),
        error: err instanceof Error ? err.message : "Unknown error"
      };
    }
    this.emit("status", this._status);
  }
}
const DEFAULT_CONFIG = {
  engagement: {
    id: "default",
    name: "Default Engagement"
  },
  operator: {
    id: "operator-1",
    name: "Operator"
  },
  network: {
    whitelist: [],
    blacklist: [],
    checkInterval: 60,
    providers: [],
    confirmations: 3,
    ipMode: "auto",
    showWifiName: false
  },
  scope: {
    enforcement: "warn",
    targets: [],
    excludeTargets: [],
    scopeFile: null
  },
  screenshot: {
    quality: 85
  },
  overlay: {
    showMarkButton: true,
    showInDock: true
  },
  terminal: {
    maxCastBytes: 50 * 1024 * 1024
  },
  browser: {
    binary: "",
    proxy: "http://127.0.0.1:8080",
    cdpPort: 9222,
    isolateProfile: true,
    ignoreCertErrors: true,
    startUrl: "",
    extraArgs: []
  },
  redaction: {
    allowlist: [],
    denylist: [],
    entropyThreshold: 4.5,
    minLength: 20
  },
  deconfliction: {
    enabled: false,
    url: "",
    secret: "",
    events: ["marker", "system", "credential_use", "c2_checkin"],
    subtypes: ["scope_violation"],
    includeData: false
  }
};
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) && target[key] && typeof target[key] === "object") {
      result[key] = deepMerge(target[key], source[key]);
    } else if (source[key] !== void 0) {
      result[key] = source[key];
    }
  }
  return result;
}
function migrateConfig(parsed) {
  const network = parsed.network;
  if (network) {
    if (network.vpnIPs && !network.whitelist && !network.safeIPs) {
      network.whitelist = network.vpnIPs;
      delete network.vpnIPs;
    }
    if (network.safeIPs && !network.whitelist) {
      network.whitelist = network.safeIPs;
      delete network.safeIPs;
    }
    if (network.dailyIPs && !network.blacklist && !network.exposedIPs) {
      network.blacklist = network.dailyIPs;
      delete network.dailyIPs;
    }
    if (network.exposedIPs && !network.blacklist) {
      network.blacklist = network.exposedIPs;
      delete network.exposedIPs;
    }
  }
  return parsed;
}
function loadConfig(projectDir) {
  const configPath = path.join(projectDir, "config.yaml");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = migrateConfig(yaml.load(raw));
    return deepMerge(DEFAULT_CONFIG, parsed);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
function saveConfig(projectDir, config) {
  fs.mkdirSync(projectDir, { recursive: true });
  const configPath = path.join(projectDir, "config.yaml");
  fs.writeFileSync(configPath, yaml.dump(config, { lineWidth: 120 }), "utf-8");
}
function loadScopeFile(scopeFilePath) {
  try {
    const raw = fs.readFileSync(scopeFilePath, "utf-8");
    const ext = path.extname(scopeFilePath).toLowerCase();
    if (ext === ".json") {
      const data = JSON.parse(raw);
      if (data.target?.scope) {
        return data.target.scope.flatMap((s) => {
          if (s.host) return [s.host.replace(/^\\Q|\\E$/g, "").replace(/^\.\*/g, "*")];
          return [];
        });
      }
      if (Array.isArray(data)) return data.filter((x) => typeof x === "string");
      return [];
    }
    return raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}
let db = null;
let currentProjectDir = null;
function initDB(projectDir) {
  if (db) closeDB();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "screenshots"), { recursive: true });
  const dbPath = path.join(projectDir, "timeline.db");
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      engagement_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      agent_type TEXT NOT NULL,
      hostname TEXT NOT NULL DEFAULT '',
      source_ip TEXT,
      target_id TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      hash TEXT,
      prev_hash TEXT,
      created_at INTEGER NOT NULL,
      monotonic_ns TEXT,
      ntp_offset_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(agent_type);
    CREATE INDEX IF NOT EXISTS idx_events_engagement ON events(engagement_id);
    CREATE INDEX IF NOT EXISTS idx_events_target ON events(target_id);

    CREATE TABLE IF NOT EXISTS quickmarks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT,
      note TEXT NOT NULL DEFAULT '',
      context TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_quickmarks_ts ON quickmarks(created_at);

    CREATE TABLE IF NOT EXISTS event_annotations (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_annotation_event ON event_annotations(event_id);

    CREATE TABLE IF NOT EXISTS operators (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_operator_token ON operators(token_hash);

    CREATE TABLE IF NOT EXISTS chain_anchors (
      id TEXT PRIMARY KEY,
      head_event_id TEXT,
      head_hash TEXT NOT NULL,
      event_count INTEGER NOT NULL,
      calendar_receipts TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_anchor_ts ON chain_anchors(created_at);
  `);
  const cols = db.prepare("PRAGMA table_info(events)").all();
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("prev_hash")) db.exec("ALTER TABLE events ADD COLUMN prev_hash TEXT");
  if (!colNames.has("monotonic_ns")) db.exec("ALTER TABLE events ADD COLUMN monotonic_ns TEXT");
  if (!colNames.has("ntp_offset_ms")) db.exec("ALTER TABLE events ADD COLUMN ntp_offset_ms INTEGER");
  currentProjectDir = projectDir;
  return db;
}
function getDB() {
  if (!db) throw new Error("Database not initialized");
  return db;
}
function closeDB() {
  db?.close();
  db = null;
  currentProjectDir = null;
}
function getProjectDir$1() {
  if (!currentProjectDir) throw new Error("No project loaded");
  return currentProjectDir;
}
let cachedOffsetMs = null;
let lastQueryAt = 0;
let queryTimer = null;
const NTP_SERVER = process.env.REDLOG_NTP_SERVER || "pool.ntp.org";
const NTP_TIMEOUT_MS = 4e3;
function monotonicNs() {
  return process.hrtime.bigint().toString();
}
function getNtpOffsetMs() {
  return cachedOffsetMs;
}
function getLastNtpQuery() {
  return lastQueryAt;
}
function queryNtp(server2 = NTP_SERVER) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const packet = Buffer.alloc(48);
    packet[0] = 27;
    let done = false;
    const finish = (err, offsetMs) => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
      }
      if (err) reject(err);
      else resolve(offsetMs ?? 0);
    };
    const timer = setTimeout(() => finish(new Error("NTP timeout")), NTP_TIMEOUT_MS);
    socket.on("message", (msg) => {
      clearTimeout(timer);
      const t4 = Date.now();
      const secs = msg.readUInt32BE(40);
      const frac = msg.readUInt32BE(44);
      const NTP_EPOCH_OFFSET = 2208988800;
      const serverMs = (secs - NTP_EPOCH_OFFSET) * 1e3 + Math.floor(frac / 4294967295 * 1e3);
      const offset = serverMs - t4;
      finish(null, offset);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      finish(err);
    });
    socket.send(packet, 123, server2, (err) => {
      if (err) {
        clearTimeout(timer);
        finish(err);
      }
    });
  });
}
async function tick() {
  try {
    const offset = await queryNtp();
    cachedOffsetMs = Math.round(offset);
    lastQueryAt = Date.now();
  } catch {
  }
}
function startNtpLoop(intervalMs = 5 * 60 * 1e3) {
  stopNtpLoop();
  queryTimer = setInterval(tick, intervalMs);
  setTimeout(tick, 5e3);
}
function stopNtpLoop() {
  if (queryTimer) {
    clearInterval(queryTimer);
    queryTimer = null;
  }
}
let sessionId = crypto.randomUUID();
const ALLOWED_NO_TARGET_TYPES = /* @__PURE__ */ new Set(["marker", "screenshot"]);
const EXCLUDED_NO_TARGET_TYPES = /* @__PURE__ */ new Set(["clipboard", "system"]);
function insertEvent(agentType, data, opts) {
  const db2 = getDB();
  const now = Date.now();
  if (agentType === "shell" && data.command) {
    const twoSecondsAgo = now - 2e3;
    const dup = db2.prepare(
      `SELECT id FROM events WHERE agent_type = 'shell' AND timestamp >= ? AND data LIKE ? ORDER BY timestamp DESC LIMIT 1`
    ).get(twoSecondsAgo, `%"command":"${String(data.command).replace(/"/g, '\\"')}"%`);
    if (dup) return null;
  }
  const prevRow = db2.prepare(
    "SELECT hash FROM events ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).get();
  const prevHash = prevRow?.hash ?? null;
  if (!opts?.operatorId) {
    throw new Error(`insertEvent: operatorId is required (agent_type=${agentType}). Every event must resolve to a known operator — see docs/operators.md.`);
  }
  const event = {
    id: crypto.randomUUID(),
    timestamp: now,
    engagementId: opts?.engagementId ?? "default",
    sessionId,
    operatorId: opts.operatorId,
    agentType,
    hostname: os.hostname(),
    sourceIP: null,
    targetId: opts?.targetId ?? null,
    data,
    prevHash,
    createdAt: now,
    monotonicNs: monotonicNs(),
    ntpOffsetMs: getNtpOffsetMs()
  };
  const hash = crypto.createHash("sha256").update(JSON.stringify({ ...event, hash: void 0, prevHash })).digest("hex");
  event.hash = hash;
  db2.prepare(`
    INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id, agent_type, hostname, source_ip, target_id, data, hash, prev_hash, created_at, monotonic_ns, ntp_offset_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.timestamp,
    event.engagementId,
    event.sessionId,
    event.operatorId,
    event.agentType,
    event.hostname,
    event.sourceIP,
    event.targetId,
    JSON.stringify(event.data),
    event.hash,
    event.prevHash,
    event.createdAt,
    event.monotonicNs,
    event.ntpOffsetMs
  );
  return event;
}
function queryEvents(opts) {
  const db2 = getDB();
  const conditions = [];
  const params = [];
  if (opts.agentType) {
    conditions.push("agent_type = ?");
    params.push(opts.agentType);
  }
  if (opts.since) {
    conditions.push("timestamp >= ?");
    params.push(opts.since);
  }
  if (opts.targetId) {
    conditions.push("target_id = ?");
    params.push(opts.targetId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  const rows = db2.prepare(
    `SELECT * FROM events ${where} ORDER BY timestamp DESC LIMIT ?`
  ).all(...params, limit);
  return rows.map(rowToEvent);
}
function getEventCount() {
  const db2 = getDB();
  const row = db2.prepare("SELECT COUNT(*) as count FROM events").get();
  return row.count;
}
function searchEvents(query, limit = 100) {
  const db2 = getDB();
  const pattern = `%${query}%`;
  const rows = db2.prepare(
    `SELECT * FROM events WHERE data LIKE ? OR target_id LIKE ? OR agent_type LIKE ?
     ORDER BY timestamp DESC LIMIT ?`
  ).all(pattern, pattern, pattern, limit);
  return rows.map(rowToEvent);
}
function queryScopeFilteredEvents(scopeTargets) {
  const db2 = getDB();
  const all = db2.prepare(
    "SELECT * FROM events ORDER BY timestamp DESC LIMIT 100000"
  ).all();
  const events2 = all.map(rowToEvent);
  if (scopeTargets.length === 0) return events2;
  return events2.filter((e) => {
    if (e.targetId) {
      return scopeTargets.some((t) => matchTarget(e.targetId, t));
    }
    if (ALLOWED_NO_TARGET_TYPES.has(e.agentType)) return true;
    if (EXCLUDED_NO_TARGET_TYPES.has(e.agentType)) return false;
    return false;
  });
}
function matchTarget(target, pattern) {
  const t = target.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const domain = p.slice(2);
    return t === domain || t.endsWith("." + domain);
  }
  if (p.includes("/")) {
    return t.startsWith(p.split("/")[0]);
  }
  return t === p || t.includes(p);
}
function rowToEvent(row) {
  return {
    id: row.id,
    timestamp: row.timestamp,
    engagementId: row.engagement_id,
    sessionId: row.session_id,
    operatorId: row.operator_id,
    agentType: row.agent_type,
    hostname: row.hostname,
    sourceIP: row.source_ip,
    targetId: row.target_id,
    data: JSON.parse(row.data),
    hash: row.hash,
    prevHash: row.prev_hash ?? null,
    createdAt: row.created_at,
    monotonicNs: row.monotonic_ns ?? null,
    ntpOffsetMs: row.ntp_offset_ms ?? null
  };
}
function rowToQuickMark(row) {
  return {
    id: row.id,
    title: row.title,
    url: row.url,
    note: row.note,
    context: JSON.parse(row.context || "{}"),
    createdAt: row.created_at
  };
}
function createQuickMark(data) {
  const db2 = getDB();
  const id = crypto.randomUUID();
  const now = Date.now();
  db2.prepare(
    "INSERT INTO quickmarks (id, title, url, note, context, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, data.title, data.url || null, data.note || "", JSON.stringify(data.context || {}), now);
  return { id, title: data.title, url: data.url || null, note: data.note || "", context: data.context || {}, createdAt: now };
}
function listQuickMarks() {
  const db2 = getDB();
  const rows = db2.prepare("SELECT * FROM quickmarks ORDER BY created_at DESC").all();
  return rows.map((r) => rowToQuickMark(r));
}
function getQuickMark(id) {
  const db2 = getDB();
  const row = db2.prepare("SELECT * FROM quickmarks WHERE id = ?").get(id);
  return row ? rowToQuickMark(row) : null;
}
function updateQuickMark(id, data) {
  const db2 = getDB();
  const existing = getQuickMark(id);
  if (!existing) return null;
  const title = data.title ?? existing.title;
  const url2 = data.url ?? existing.url;
  const note = data.note ?? existing.note;
  db2.prepare("UPDATE quickmarks SET title = ?, url = ?, note = ? WHERE id = ?").run(title, url2, note, id);
  return { ...existing, title, url: url2, note };
}
function deleteQuickMark(id) {
  const db2 = getDB();
  const result = db2.prepare("DELETE FROM quickmarks WHERE id = ?").run(id);
  return result.changes > 0;
}
let cdpPort = 9222;
let lastContext = { url: null, title: null, connected: false };
function setCdpPort(port) {
  cdpPort = port;
}
function fetchJson(url2, timeout = 2e3) {
  return new Promise((resolve, reject) => {
    const req = http.get(url2, { timeout }, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout"));
    });
  });
}
async function getActiveBrowserTab() {
  try {
    const tabs = await fetchJson(`http://127.0.0.1:${cdpPort}/json`);
    const page = tabs.find((t) => t.type === "page");
    if (page) {
      lastContext = { url: page.url, title: page.title, connected: true };
    } else {
      lastContext = { url: null, title: null, connected: true };
    }
  } catch {
    lastContext = { url: null, title: null, connected: false };
  }
  return lastContext;
}
class RedLogEventBus extends events.EventEmitter {
  constructor() {
    super(...arguments);
    this._paused = false;
  }
  get paused() {
    return this._paused;
  }
  pause() {
    this._paused = true;
    this.emit("recording", false);
  }
  resume() {
    this._paused = false;
    this.emit("recording", true);
  }
  publish(event) {
    if (this._paused) return;
    this.emit("event", event);
    this.emit(`event:${event.agentType}`, event);
  }
}
const eventBus = new RedLogEventBus();
class ScreenshotAgent {
  constructor() {
    this.lastHash = "";
    this.engagementId = "default";
    this.operatorId = "";
    this.quality = 85;
  }
  configure(opts) {
    if (opts.engagementId) this.engagementId = opts.engagementId;
    if (opts.operatorId) this.operatorId = opts.operatorId;
    if (opts.quality) this.quality = opts.quality;
  }
  async captureNow(trigger) {
    if (!this.operatorId) return null;
    try {
      const display = electron.screen.getPrimaryDisplay();
      const { width, height } = display.size;
      const sources = await electron.desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height }
      });
      if (!sources.length) return null;
      const image = sources[0].thumbnail;
      const jpeg = image.toJPEG(this.quality);
      const sha256 = crypto.createHash("sha256").update(jpeg).digest("hex");
      const dedupKey = sha256.slice(0, 16);
      if (trigger !== "manual" && dedupKey === this.lastHash) return null;
      this.lastHash = dedupKey;
      const dir = path.join(getProjectDir$1(), "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const filename = `${ts}_${trigger}.jpg`;
      const filepath = path.join(dir, filename);
      fs.writeFileSync(filepath, jpeg);
      const evt = insertEvent("screenshot", {
        trigger,
        filePath: filepath,
        filename,
        size: jpeg.length,
        width,
        height,
        sha256,
        hash: dedupKey
      }, { engagementId: this.engagementId, operatorId: this.operatorId });
      if (evt) eventBus.publish(evt);
      return filepath;
    } catch {
      return null;
    }
  }
}
function ipToLong(ip) {
  return ip.split(".").reduce((acc, o) => (acc << 8) + parseInt(o), 0) >>> 0;
}
function matchesCIDR(ip, cidr) {
  if (!cidr.includes("/")) return ip === cidr;
  const [net, bits] = cidr.split("/");
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(net) & mask);
}
function matchesDomain(host2, pattern) {
  if (pattern.startsWith("*.")) {
    return host2 === pattern.slice(2) || host2.endsWith("." + pattern.slice(2));
  }
  return host2 === pattern;
}
function getRootDomain(host2) {
  const parts = host2.split(".");
  if (parts.length <= 2) return host2;
  return parts.slice(-2).join(".");
}
function extractRootDomains(targets) {
  const roots = /* @__PURE__ */ new Set();
  for (const t of targets) {
    if (IP_RE$1.test(t) || t.includes("/")) continue;
    const domain = t.startsWith("*.") ? t.slice(2) : t;
    roots.add(getRootDomain(domain));
  }
  return roots;
}
const IP_RE$1 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
class ScopeMonitor {
  constructor() {
    this.config = { enforcement: "warn", targets: [], excludeTargets: [] };
    this.engagementId = "default";
    this.operatorId = "";
    this.violations = [];
    this.rootDomains = /* @__PURE__ */ new Set();
  }
  configure(opts) {
    if (opts.enforcement) this.config.enforcement = opts.enforcement;
    if (opts.targets) this.config.targets = opts.targets;
    if (opts.excludeTargets) this.config.excludeTargets = opts.excludeTargets;
    if (opts.engagementId) this.engagementId = opts.engagementId;
    if (opts.operatorId) this.operatorId = opts.operatorId;
    this.rootDomains = extractRootDomains(this.config.targets);
  }
  checkTarget(target, command) {
    if (this.config.targets.length === 0) return { inScope: true, violation: false };
    const isExcluded = this.config.excludeTargets.some(
      (ex) => IP_RE$1.test(target) ? matchesCIDR(target, ex) : matchesDomain(target, ex)
    );
    if (isExcluded) {
      this.recordViolation(target, command, "excluded_target");
      return { inScope: false, violation: true };
    }
    const isInScope = this.config.targets.some(
      (t) => IP_RE$1.test(target) ? matchesCIDR(target, t) : matchesDomain(target, t)
    );
    if (isInScope) return { inScope: true, violation: false };
    const isIP = IP_RE$1.test(target);
    if (!isIP) {
      const targetRoot = getRootDomain(target);
      if (!this.rootDomains.has(targetRoot)) {
        return { inScope: false, violation: false };
      }
    }
    this.recordViolation(target, command, "out_of_scope");
    return { inScope: false, violation: true };
  }
  recordViolation(target, command, reason) {
    this.violations.push({ target, command, timestamp: Date.now() });
    if (!this.operatorId) return;
    try {
      const evt = insertEvent("system", {
        subtype: "scope_violation",
        target,
        command: command.slice(0, 200),
        reason,
        enforcement: this.config.enforcement
      }, { engagementId: this.engagementId, operatorId: this.operatorId, targetId: target });
      if (evt) eventBus.publish(evt);
    } catch {
    }
  }
  getViolations() {
    return [...this.violations];
  }
  getViolationCount() {
    return this.violations.length;
  }
  isConfigured() {
    return this.config.targets.length > 0;
  }
}
const LOOT_PATTERNS = [
  { type: "password_hash", pattern: /\$[126][\$a-z]*\$[./A-Za-z0-9]+/g, confidence: "high" },
  { type: "ntlm_hash", pattern: /[a-fA-F0-9]{32}:[a-fA-F0-9]{32}/g, confidence: "high" },
  { type: "private_key", pattern: /-----BEGIN\s+(RSA\s+|EC\s+|DSA\s+|OPENSSH\s+)?PRIVATE KEY-----/g, confidence: "high" },
  { type: "aws_key", pattern: /AKIA[0-9A-Z]{16}/g, confidence: "high" },
  { type: "jwt", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, confidence: "medium" },
  { type: "generic_api_key", pattern: /(?:api[_-]?key|apikey|token|secret|password)\s*[=:]\s*['"]?([^\s'"]{8,})/gi, confidence: "medium" },
  { type: "database_url", pattern: /(?:mysql|postgres|mongodb|redis):\/\/[^\s]+/gi, confidence: "high" },
  { type: "shadow_entry", pattern: /^[a-z_][a-z0-9_-]*:\$[^:]+:[^:]*:[^:]*:[^:]*:[^:]*:/gm, confidence: "high" },
  { type: "flag", pattern: /(?:flag|ctf|HTB)\{[^}]+\}/gi, confidence: "high" },
  { type: "base64_creds", pattern: /(?:Authorization|auth):\s*Basic\s+[A-Za-z0-9+/=]{10,}/gi, confidence: "medium" }
];
const externalPatterns$1 = [];
function registerLootPatterns(pluginId, patterns) {
  let added = 0;
  for (const p of patterns) {
    try {
      const flags = new Set(["g", ...(p.flags ?? "").split("")].filter(Boolean));
      const re = new RegExp(p.pattern, [...flags].join(""));
      externalPatterns$1.push({ type: p.type, pattern: re, confidence: p.confidence ?? "medium", pluginId });
      added++;
    } catch {
    }
  }
  return added;
}
function unregisterLootPatterns(pluginId) {
  for (let i = externalPatterns$1.length - 1; i >= 0; i--) {
    if (externalPatterns$1[i].pluginId === pluginId) externalPatterns$1.splice(i, 1);
  }
}
class LootDetector {
  constructor() {
    this.engagementId = "default";
    this.operatorId = "";
    this.detectedHashes = /* @__PURE__ */ new Set();
  }
  configure(opts) {
    if (opts.engagementId) this.engagementId = opts.engagementId;
    if (opts.operatorId) this.operatorId = opts.operatorId;
  }
  scan(text, targetId) {
    const matches = [];
    for (const { type, pattern, confidence } of [...LOOT_PATTERNS, ...externalPatterns$1]) {
      const re = new RegExp(pattern.source, pattern.flags);
      let m;
      while ((m = re.exec(text)) !== null) {
        const value = m[1] || m[0];
        const key = `${type}:${value.slice(0, 32)}`;
        if (this.detectedHashes.has(key)) continue;
        this.detectedHashes.add(key);
        const lineStart = text.lastIndexOf("\n", m.index) + 1;
        const lineEnd = text.indexOf("\n", m.index);
        const line = text.slice(lineStart, lineEnd === -1 ? void 0 : lineEnd).trim().slice(0, 200);
        matches.push({ type, value: value.slice(0, 500), line, confidence });
      }
    }
    if (matches.length > 0 && this.operatorId) {
      try {
        const evt = insertEvent("loot", {
          subtype: "credential_detected",
          matches: matches.map((m) => ({ type: m.type, confidence: m.confidence, preview: m.line })),
          count: matches.length
        }, {
          engagementId: this.engagementId,
          operatorId: this.operatorId,
          targetId
        });
        if (evt) eventBus.publish(evt);
      } catch {
      }
    }
    return matches;
  }
  getLootCount() {
    return this.detectedHashes.size;
  }
}
function getChainLength() {
  const db2 = getDB();
  const row = db2.prepare("SELECT COUNT(*) as count FROM events WHERE hash IS NOT NULL").get();
  return row.count;
}
const UPGRADED_MIN_BYTES = 200;
const DEFAULT_CALENDARS = [
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://finney.calendar.eternitywall.com"
];
const HTTP_TIMEOUT_MS = 15e3;
function rowToAnchor(row) {
  let receipts = [];
  try {
    receipts = JSON.parse(row.calendar_receipts);
  } catch {
  }
  return {
    id: row.id,
    headEventId: row.head_event_id,
    headHash: row.head_hash,
    eventCount: row.event_count,
    calendarReceipts: receipts,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}
function computeChainHead() {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT id, hash FROM events WHERE hash IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get();
  const countRow = db2.prepare(
    `SELECT COUNT(*) as count FROM events WHERE hash IS NOT NULL`
  ).get();
  if (!row) return null;
  const hash = crypto.createHash("sha256").update(row.hash).update(String(countRow.count)).digest("hex");
  return { hash, headEventId: row.id, eventCount: countRow.count };
}
function listAnchors(limit = 50) {
  const db2 = getDB();
  const rows = db2.prepare(
    `SELECT id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at
     FROM chain_anchors ORDER BY created_at DESC LIMIT ?`
  ).all(limit);
  return rows.map(rowToAnchor);
}
function getLastAnchor() {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at
     FROM chain_anchors ORDER BY created_at DESC LIMIT 1`
  ).get();
  return row ? rowToAnchor(row) : null;
}
function postDigest(calendarUrl, hashBytes) {
  return new Promise((resolve) => {
    const submittedAt = Date.now();
    const parsed = new url.URL(calendarUrl + "/digest");
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.opentimestamps.v1",
        "Content-Length": hashBytes.length,
        "User-Agent": "RedLog-anchor/0.1"
      },
      timeout: HTTP_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && body.length > 0) {
          resolve({
            calendar: calendarUrl,
            ok: true,
            receiptB64: body.toString("base64"),
            submittedAt
          });
        } else {
          resolve({
            calendar: calendarUrl,
            ok: false,
            error: `HTTP ${res.statusCode}`,
            submittedAt
          });
        }
      });
    });
    req.on("error", (err) => {
      resolve({ calendar: calendarUrl, ok: false, error: err.message, submittedAt });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ calendar: calendarUrl, ok: false, error: "timeout", submittedAt });
    });
    req.write(hashBytes);
    req.end();
  });
}
function insertAnchor(a) {
  const db2 = getDB();
  const id = crypto.randomUUID();
  db2.prepare(
    `INSERT INTO chain_anchors (id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    a.headEventId,
    a.headHash,
    a.eventCount,
    JSON.stringify(a.calendarReceipts),
    a.status,
    a.createdAt,
    a.completedAt
  );
  return { ...a, id };
}
async function anchorNow(calendars = DEFAULT_CALENDARS) {
  const head = computeChainHead();
  if (!head) return null;
  const hashBytes = Buffer.from(head.hash, "hex");
  const receipts = await Promise.all(calendars.map((cal) => postDigest(cal, hashBytes)));
  const okCount = receipts.filter((r) => r.ok).length;
  let status = "failed";
  if (okCount > 0 && okCount === calendars.length) status = "complete";
  else if (okCount > 0) status = "partial";
  const now = Date.now();
  return insertAnchor({
    headEventId: head.headEventId,
    headHash: head.hash,
    eventCount: head.eventCount,
    calendarReceipts: receipts,
    status,
    createdAt: now,
    completedAt: okCount > 0 ? now : null
  });
}
let loopTimer = null;
let upgradeTimer = null;
function startAnchorLoop(intervalMs = 60 * 60 * 1e3, upgradeIntervalMs = 6 * 60 * 60 * 1e3) {
  stopAnchorLoop();
  const tick2 = async () => {
    try {
      const head = computeChainHead();
      if (!head) return;
      const last = getLastAnchor();
      if (last && last.headHash === head.hash && last.status !== "failed") return;
      await anchorNow();
    } catch {
    }
  };
  loopTimer = setInterval(tick2, intervalMs);
  setTimeout(tick2, 3e4);
  const upgradeTick = async () => {
    try {
      await upgradeAllPending();
    } catch {
    }
  };
  upgradeTimer = setInterval(upgradeTick, upgradeIntervalMs);
  setTimeout(upgradeTick, 2 * 6e4);
}
function stopAnchorLoop() {
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (upgradeTimer) {
    clearInterval(upgradeTimer);
    upgradeTimer = null;
  }
}
function verifyLatestAnchor() {
  const last = getLastAnchor();
  const head = computeChainHead();
  if (!last || !head) return { ok: false, anchor: last, currentHead: head?.hash ?? null };
  const ok = last.eventCount <= head.eventCount;
  return { ok, anchor: last, currentHead: head.hash };
}
const OTS_MAGIC = Buffer.from([
  0,
  79,
  112,
  101,
  110,
  84,
  105,
  109,
  101,
  115,
  116,
  97,
  109,
  112,
  115,
  0,
  0,
  80,
  114,
  111,
  111,
  102,
  0,
  191,
  137,
  226,
  232,
  132,
  232,
  146,
  148
]);
const OTS_VERSION = 1;
const OTS_OP_SHA256 = 8;
function buildOtsBundle(headHashHex, receiptB64) {
  const digest = Buffer.from(headHashHex, "hex");
  if (digest.length !== 32) throw new Error(`headHash must be 32 bytes (SHA-256), got ${digest.length}`);
  const timestamp = Buffer.from(receiptB64, "base64");
  return Buffer.concat([
    OTS_MAGIC,
    Buffer.from([OTS_VERSION, OTS_OP_SHA256]),
    digest,
    timestamp
  ]);
}
function getTimestamp(calendarUrl, headHashHex) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new url.URL(calendarUrl + "/timestamp/" + headHashHex);
    } catch (e) {
      return resolve({ ok: false, status: 0, error: e.message });
    }
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname,
      method: "GET",
      headers: {
        "Accept": "application/vnd.opentimestamps.v1",
        "User-Agent": "RedLog-anchor/0.1"
      },
      timeout: HTTP_TIMEOUT_MS
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        const s = res.statusCode ?? 0;
        if (s >= 200 && s < 300 && body.length > 0) resolve({ ok: true, status: s, body });
        else resolve({ ok: false, status: s, error: `HTTP ${s}` });
      });
    });
    req.on("error", (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: "timeout" });
    });
    req.end();
  });
}
async function upgradeAnchor(id) {
  const db2 = getDB();
  const existing = getAnchorById(id);
  if (!existing) return null;
  const receipts = await Promise.all(existing.calendarReceipts.map(async (r) => {
    if (!r.ok || r.upgraded) return r;
    const res = await getTimestamp(r.calendar, existing.headHash);
    if (res.ok && res.body) {
      const b64 = res.body.toString("base64");
      const wasPending = r.receiptB64 ?? "";
      const isBigger = res.body.length >= UPGRADED_MIN_BYTES && b64 !== wasPending;
      return {
        ...r,
        receiptB64: b64,
        upgraded: isBigger,
        upgradedAt: isBigger ? Date.now() : r.upgradedAt ?? null,
        upgradedBytes: res.body.length
      };
    }
    return { ...r, upgraded: false, upgradedAt: r.upgradedAt ?? null, error: res.error ?? r.error };
  }));
  const anyUpgraded = receipts.some((r) => r.upgraded);
  const allUpgraded = receipts.filter((r) => r.ok).every((r) => r.upgraded);
  const status = allUpgraded ? "complete" : anyUpgraded ? "partial" : existing.status;
  db2.prepare(
    `UPDATE chain_anchors SET calendar_receipts = ?, status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?`
  ).run(JSON.stringify(receipts), status, anyUpgraded ? Date.now() : existing.completedAt, id);
  return getAnchorById(id);
}
async function upgradeAllPending() {
  const anchors = listAnchors(1e3).filter((a) => a.calendarReceipts.some((r) => r.ok && !r.upgraded));
  let upgraded = 0;
  for (const a of anchors) {
    const result = await upgradeAnchor(a.id);
    if (result && result.calendarReceipts.some((r) => r.upgraded)) upgraded++;
  }
  return { upgraded, scanned: anchors.length };
}
function getAnchorById(id) {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT id, head_event_id, head_hash, event_count, calendar_receipts, status, created_at, completed_at
     FROM chain_anchors WHERE id = ?`
  ).get(id);
  return row ? rowToAnchor(row) : null;
}
const CLOCK_TOLERANCE_MS = 5e3;
function verifyChainFull() {
  const db2 = getDB();
  const anchor = getLastAnchor();
  const currentHead = computeChainHead();
  const rowIter = db2.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms
     FROM events ORDER BY created_at ASC, rowid ASC`
  ).iterate();
  let walked = 0;
  let expectedPrev = null;
  let lastHash = null;
  const clockAnomalies = [];
  const prevByHostSession = /* @__PURE__ */ new Map();
  for (const row of rowIter) {
    walked++;
    if ((row.prev_hash ?? null) !== expectedPrev) {
      return {
        ok: false,
        walked,
        brokenAtEventId: row.id,
        brokenReason: `prev_hash mismatch (expected ${expectedPrev ?? "null"}, got ${row.prev_hash ?? "null"})`,
        currentHead: currentHead?.hash ?? null,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies
      };
    }
    const reconstructed = {
      id: row.id,
      timestamp: row.timestamp,
      engagementId: row.engagement_id,
      sessionId: row.session_id,
      operatorId: row.operator_id,
      agentType: row.agent_type,
      hostname: row.hostname,
      sourceIP: row.source_ip,
      targetId: row.target_id,
      data: JSON.parse(row.data),
      hash: void 0,
      prevHash: row.prev_hash,
      createdAt: row.created_at,
      monotonicNs: row.monotonic_ns ?? null,
      ntpOffsetMs: row.ntp_offset_ms ?? null
    };
    const expectedHash = crypto.createHash("sha256").update(JSON.stringify(reconstructed)).digest("hex");
    if (expectedHash !== row.hash) {
      return {
        ok: false,
        walked,
        brokenAtEventId: row.id,
        brokenReason: `hash mismatch (recomputed ${expectedHash.slice(0, 16)}..., stored ${(row.hash ?? "").slice(0, 16)}...)`,
        currentHead: currentHead?.hash ?? null,
        anchor,
        anchorMatchesWalkedHead: false,
        clockAnomalies
      };
    }
    const key = `${row.hostname}|${row.session_id}`;
    const prev = prevByHostSession.get(key);
    if (prev && prev.monotonic_ns && row.monotonic_ns) {
      const wallDelta = row.timestamp - prev.timestamp;
      const monoDelta = Number((BigInt(row.monotonic_ns) - BigInt(prev.monotonic_ns)) / 1000000n);
      const diff = Math.abs(wallDelta - monoDelta);
      if (diff > CLOCK_TOLERANCE_MS) {
        clockAnomalies.push({
          eventId: row.id,
          prevEventId: prev.id,
          hostname: row.hostname,
          sessionId: row.session_id,
          wallDeltaMs: wallDelta,
          monoDeltaMs: monoDelta,
          diffMs: diff
        });
      }
    }
    prevByHostSession.set(key, row);
    expectedPrev = row.hash;
    lastHash = row.hash;
  }
  let anchorMatchesWalkedHead = false;
  if (anchor && lastHash) {
    const walkedHead = crypto.createHash("sha256").update(lastHash).update(String(walked)).digest("hex");
    anchorMatchesWalkedHead = walkedHead === anchor.headHash || anchor.eventCount <= walked;
  }
  return {
    ok: true,
    walked,
    brokenAtEventId: null,
    brokenReason: null,
    currentHead: currentHead?.hash ?? null,
    anchor,
    anchorMatchesWalkedHead,
    clockAnomalies
  };
}
const DEFAULT_RULES = {
  allowlist: [],
  denylist: [],
  entropyThreshold: 4.5,
  minLength: 20
};
let activeRules = { ...DEFAULT_RULES };
const pluginRules = /* @__PURE__ */ new Map();
function registerRedactionRules(pluginId, rules) {
  pluginRules.set(pluginId, { denylist: rules.denylist ?? [], allowlist: rules.allowlist ?? [] });
}
function unregisterRedactionRules(pluginId) {
  pluginRules.delete(pluginId);
}
function effectiveRules() {
  if (pluginRules.size === 0) return activeRules;
  const denylist = [...activeRules.denylist];
  const allowlist = [...activeRules.allowlist];
  for (const r of pluginRules.values()) {
    denylist.push(...r.denylist);
    allowlist.push(...r.allowlist);
  }
  return { ...activeRules, denylist: [...new Set(denylist)], allowlist: [...new Set(allowlist)] };
}
function configureRedaction(rules) {
  activeRules = { ...activeRules, ...rules };
}
function getRules() {
  return effectiveRules();
}
function shannonEntropy(s) {
  if (!s) return 0;
  const freq = /* @__PURE__ */ new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
const TOKEN_RE = /[A-Za-z0-9_\-\.\/+=]{16,}/g;
function matchesAny(patterns, token) {
  for (const p of patterns) {
    if (!p) continue;
    if (p.startsWith("/") && p.endsWith("/") && p.length > 2) {
      try {
        const re = new RegExp(p.slice(1, -1));
        if (re.test(token)) return true;
      } catch {
      }
    } else if (token.includes(p)) {
      return true;
    }
  }
  return false;
}
function redact(text, rules = effectiveRules()) {
  if (!text) return { text, redacted: [] };
  const redacted = [];
  const out = text.replace(TOKEN_RE, (token, offset) => {
    if (matchesAny(rules.allowlist, token)) return token;
    if (matchesAny(rules.denylist, token)) {
      redacted.push({ pattern: "denylist", hint: `${token.length} chars`, start: offset, end: offset + token.length });
      return "[REDACTED_DENY]";
    }
    if (token.length >= rules.minLength) {
      const entropy = shannonEntropy(token);
      if (entropy >= rules.entropyThreshold) {
        redacted.push({
          pattern: "entropy",
          hint: `${token.length} chars, ${entropy.toFixed(2)} bits/char`,
          start: offset,
          end: offset + token.length
        });
        return `[REDACTED_ENTROPY_${entropy.toFixed(1)}]`;
      }
    }
    return token;
  });
  return { text: out, redacted };
}
function rowToOperator(row) {
  return {
    id: row.id,
    name: row.name,
    isPrimary: !!row.is_primary,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null
  };
}
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}
function slugifyOperatorId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "op";
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}
function createOperator(opts) {
  const db2 = getDB();
  const now = Date.now();
  db2.prepare(
    `INSERT INTO operators (id, name, token_hash, is_primary, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`
  ).run(opts.id, opts.name, hashToken(opts.token), opts.isPrimary ? 1 : 0, now);
  return { id: opts.id, name: opts.name, isPrimary: !!opts.isPrimary, createdAt: now, revokedAt: null };
}
function updateOperatorToken(id, token) {
  const db2 = getDB();
  const info = db2.prepare(
    `UPDATE operators SET token_hash = ?, revoked_at = NULL WHERE id = ?`
  ).run(hashToken(token), id);
  return info.changes > 0;
}
function renameOperator(id, name) {
  const db2 = getDB();
  const info = db2.prepare(`UPDATE operators SET name = ? WHERE id = ?`).run(name, id);
  return info.changes > 0;
}
function revokeOperator(id) {
  const db2 = getDB();
  const info = db2.prepare(
    `UPDATE operators SET revoked_at = ? WHERE id = ? AND is_primary = 0`
  ).run(Date.now(), id);
  return info.changes > 0;
}
function deleteOperator(id) {
  const db2 = getDB();
  const info = db2.prepare(`DELETE FROM operators WHERE id = ? AND is_primary = 0`).run(id);
  return info.changes > 0;
}
function listOperators() {
  const db2 = getDB();
  const rows = db2.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at
     FROM operators ORDER BY is_primary DESC, created_at ASC`
  ).all();
  return rows.map(rowToOperator);
}
function resolveOperatorByToken(token) {
  if (!token) return null;
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at
     FROM operators WHERE token_hash = ? AND revoked_at IS NULL`
  ).get(hashToken(token));
  return row ? rowToOperator(row) : null;
}
function getPrimaryOperator() {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT id, name, token_hash, is_primary, created_at, revoked_at
     FROM operators WHERE is_primary = 1 LIMIT 1`
  ).get();
  return row ? rowToOperator(row) : null;
}
function getPrimaryOperatorTokenHash() {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT token_hash FROM operators WHERE is_primary = 1 LIMIT 1`
  ).get();
  return row?.token_hash ?? null;
}
function ensurePrimaryOperator(id, name, token) {
  const db2 = getDB();
  const existing = getPrimaryOperator();
  if (existing) {
    if (existing.id !== id || existing.name !== name) {
      db2.prepare(`UPDATE operators SET id = ?, name = ? WHERE is_primary = 1`).run(id, name);
    }
    updateOperatorToken(id, token);
    return { ...existing, id, name };
  }
  return createOperator({ id, name, token, isPrimary: true });
}
function sha256File(p) {
  const buf = fs.readFileSync(p);
  return { bytes: buf.length, sha256: crypto.createHash("sha256").update(buf).digest("hex") };
}
function writeAndHash(dest, contents) {
  fs.writeFileSync(dest, contents);
  const info = sha256File(dest);
  return { path: path.basename(dest), bytes: info.bytes, sha256: info.sha256 };
}
function exportBundle(engagementId2, outRoot) {
  const projectDir = getProjectDir$1();
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const bundleDir = path.join(path.join(projectDir, "exports"), `bundle-${ts}`);
  fs.mkdirSync(bundleDir, { recursive: true });
  const files = [];
  const db2 = getDB();
  const eventsPath = path.join(bundleDir, "events.jsonl");
  const stream = fs.createWriteStream(eventsPath);
  const rowIter = db2.prepare(
    `SELECT id, timestamp, engagement_id, session_id, operator_id, agent_type,
            hostname, source_ip, target_id, data, hash, prev_hash, created_at,
            monotonic_ns, ntp_offset_ms
     FROM events ORDER BY created_at ASC, rowid ASC`
  ).iterate();
  for (const row of rowIter) {
    stream.write(JSON.stringify(row) + "\n");
  }
  stream.end();
  files.push({ path: "events.jsonl", ...sha256File(eventsPath) });
  files.push(writeAndHash(
    path.join(bundleDir, "quickmarks.json"),
    JSON.stringify(listQuickMarks(), null, 2)
  ));
  files.push(writeAndHash(
    path.join(bundleDir, "chain_anchors.json"),
    JSON.stringify(listAnchors(1e4), null, 2)
  ));
  files.push(writeAndHash(
    path.join(bundleDir, "operators.json"),
    JSON.stringify(listOperators().map((op) => ({
      id: op.id,
      name: op.name,
      isPrimary: op.isPrimary,
      createdAt: op.createdAt,
      revokedAt: op.revokedAt
    })), null, 2)
  ));
  const srcShots = path.join(projectDir, "screenshots");
  const dstShots = path.join(bundleDir, "screenshots");
  if (fs.existsSync(srcShots)) {
    fs.mkdirSync(dstShots, { recursive: true });
    for (const name of fs.readdirSync(srcShots)) {
      const s = path.join(srcShots, name);
      const d = path.join(dstShots, name);
      if (fs.statSync(s).isFile()) {
        fs.copyFileSync(s, d);
        const info = sha256File(d);
        files.push({ path: `screenshots/${name}`, ...info });
      }
    }
  }
  const srcCasts = path.join(projectDir, "casts");
  const dstCasts = path.join(bundleDir, "casts");
  if (fs.existsSync(srcCasts)) {
    fs.mkdirSync(dstCasts, { recursive: true });
    for (const name of fs.readdirSync(srcCasts)) {
      const s = path.join(srcCasts, name);
      const d = path.join(dstCasts, name);
      if (fs.statSync(s).isFile()) {
        fs.copyFileSync(s, d);
        const info = sha256File(d);
        files.push({ path: `casts/${name}`, ...info });
      }
    }
  }
  const head = computeChainHead();
  const lastAnchor = listAnchors(1)[0] ?? null;
  const primary = getPrimaryOperator();
  const primaryTokenHash = getPrimaryOperatorTokenHash();
  const manifest = {
    bundleVersion: 1,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    hostname: os.hostname(),
    engagementId: engagementId2,
    signedBy: primary && primaryTokenHash ? {
      operatorId: primary.id,
      operatorName: primary.name,
      tokenHashPrefix: primaryTokenHash.slice(0, 16)
    } : null,
    chainHead: head ? { hash: head.hash, eventCount: head.eventCount } : null,
    lastAnchor: lastAnchor ? {
      id: lastAnchor.id,
      headHash: lastAnchor.headHash,
      eventCount: lastAnchor.eventCount,
      status: lastAnchor.status,
      createdAt: lastAnchor.createdAt
    } : null,
    files
  };
  const manifestPath = path.join(bundleDir, "manifest.json");
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  fs.writeFileSync(manifestPath, manifestBytes);
  const manifestSha = crypto.createHash("sha256").update(manifestBytes).digest("hex");
  fs.writeFileSync(path.join(bundleDir, "manifest.sha256"), manifestSha + "\n");
  if (primaryTokenHash) {
    const hmac = crypto.createHmac("sha256", primaryTokenHash).update(manifestBytes).digest("hex");
    fs.writeFileSync(
      path.join(bundleDir, "manifest.hmac"),
      `hmac_sha256=${hmac}
token_hash_prefix=${primaryTokenHash.slice(0, 16)}
algo=HMAC-SHA256(token_hash, manifest.json)
`
    );
  }
  return { outDir: bundleDir, manifest };
}
const DEFAULT_DECONFLICTION = {
  enabled: false,
  url: "",
  secret: "",
  events: ["marker", "system", "credential_use", "c2_checkin"],
  subtypes: ["scope_violation"],
  includeData: false
};
let active = { ...DEFAULT_DECONFLICTION };
const RETRY_INTERVALS_MS = [5e3, 3e4, 12e4];
function configureDeconfliction(cfg) {
  active = { ...active, ...cfg };
}
function getDeconflictionConfig() {
  return { ...active };
}
function shouldForward(event, cfg) {
  if (!cfg.enabled || !cfg.url) return false;
  if (cfg.events.includes(event.agentType)) return true;
  const subtype = event.data?.subtype ?? "";
  return subtype !== "" && cfg.subtypes.includes(subtype);
}
function canonicalise(event, cfg) {
  const base = {
    id: event.id,
    timestamp: event.timestamp,
    engagement_id: event.engagementId,
    operator_id: event.operatorId,
    agent_type: event.agentType,
    target_id: event.targetId,
    hostname: event.hostname,
    hash: event.hash,
    subtype: event.data?.subtype ?? null,
    description: event.data?.description ?? null,
    severity: event.data?.severity ?? null,
    mitre_ttp: event.data?.mitre_ttp ?? null
  };
  if (cfg.includeData) return { ...base, data: event.data };
  return base;
}
function signBody(body, secret) {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}
function postOnce(cfg, body) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new url.URL(cfg.url);
    } catch (e) {
      return resolve({ ok: false, status: 0, error: e.message });
    }
    const transport = parsed.protocol === "https:" ? https : http;
    const sig = signBody(body, cfg.secret);
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "User-Agent": "RedLog-deconfliction/0.1",
        "X-Redlog-Signature": `sha256=${sig}`
      },
      timeout: 5e3
    }, (res) => {
      res.on("data", () => {
      });
      res.on("end", () => {
        const s = res.statusCode ?? 0;
        resolve({ ok: s >= 200 && s < 300, status: s });
      });
    });
    req.on("error", (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, error: "timeout" });
    });
    req.write(body);
    req.end();
  });
}
async function withRetry(cfg, body) {
  for (let i = 0; i < RETRY_INTERVALS_MS.length + 1; i++) {
    const res = await postOnce(cfg, body);
    if (res.ok) return;
    if (i >= RETRY_INTERVALS_MS.length) return;
    await new Promise((r) => setTimeout(r, RETRY_INTERVALS_MS[i]));
  }
}
function notifyDeconfliction(event) {
  const cfg = active;
  if (!shouldForward(event, cfg)) return;
  const body = JSON.stringify(canonicalise(event, cfg));
  withRetry(cfg, body).catch(() => {
  });
}
async function testWebhook(cfg) {
  if (!cfg.url) return { ok: false, status: 0, error: "no url configured" };
  const body = JSON.stringify({
    id: "test",
    engagement_id: "test",
    agent_type: "system",
    subtype: "deconfliction_test",
    timestamp: Date.now(),
    description: "RedLog deconfliction webhook test",
    test: true
  });
  return postOnce(cfg, body);
}
const PROJECTS_DIR = path.join(os.homedir(), ".redlog", "projects");
const INDEX_PATH = path.join(os.homedir(), ".redlog", "projects.json");
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function loadIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    return { recent: [] };
  }
}
function saveIndex(index) {
  ensureDir(path.dirname(INDEX_PATH));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
}
function listProjects() {
  const index = loadIndex();
  return index.recent.filter((p) => fs.existsSync(p.path)).sort((a, b) => b.lastOpened - a.lastOpened);
}
function createProject(name) {
  const id = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${Date.now().toString(36)}`;
  const projectPath = path.join(PROJECTS_DIR, id);
  ensureDir(projectPath);
  ensureDir(path.join(projectPath, "screenshots"));
  const meta = {
    id,
    name,
    createdAt: Date.now(),
    lastOpened: Date.now(),
    path: projectPath
  };
  const index = loadIndex();
  index.recent.unshift(meta);
  saveIndex(index);
  return meta;
}
function openProject(id) {
  const index = loadIndex();
  const project = index.recent.find((p) => p.id === id);
  if (!project || !fs.existsSync(project.path)) return null;
  project.lastOpened = Date.now();
  index.recent = [project, ...index.recent.filter((p) => p.id !== id)];
  saveIndex(index);
  return project;
}
function deleteProject(id) {
  const index = loadIndex();
  const project = index.recent.find((p) => p.id === id);
  if (!project) return false;
  index.recent = index.recent.filter((p) => p.id !== id);
  saveIndex(index);
  if (fs.existsSync(project.path)) {
    fs.rmSync(project.path, { recursive: true, force: true });
  }
  return true;
}
function getProjectDir(project) {
  ensureDir(project.path);
  ensureDir(path.join(project.path, "screenshots"));
  return project.path;
}
const URL_RE = /https?:\/\/([^/:?\s]+)/;
const IP_RE = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,2})?)\b/;
const DOMAIN_RE = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+)\b/;
const PATTERNS = [
  { cmd: /^ssh\s/, extract: (a) => a.match(/@([^\s:]+)/)?.[1] ?? a.match(IP_RE)?.[1] ?? a.match(DOMAIN_RE)?.[1] ?? null },
  { cmd: /^scp\s/, extract: (a) => a.match(/@([^\s:]+)/)?.[1] ?? null },
  { cmd: /^rsync\s/, extract: (a) => a.match(/@([^\s:]+)/)?.[1] ?? null },
  { cmd: /^nmap\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^masscan\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^rustscan\s/, extract: (a) => a.match(/-a\s+([^\s]+)/)?.[1] ?? lastIPOrDomain(a) },
  { cmd: /^curl\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^wget\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^httpie?\s|^http\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^sqlmap\s/, extract: (a) => {
    const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1];
    return u ? hostFromUrl(u) : null;
  } },
  { cmd: /^ffuf\s/, extract: (a) => {
    const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1];
    return u ? hostFromUrl(u) : null;
  } },
  { cmd: /^gobuster\s/, extract: (a) => {
    const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1];
    return u ? hostFromUrl(u) : null;
  } },
  { cmd: /^feroxbuster\s/, extract: (a) => {
    const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1];
    return u ? hostFromUrl(u) : null;
  } },
  { cmd: /^dirb\s/, extract: (a) => extractUrlHost(a) },
  { cmd: /^nikto\s/, extract: (a) => a.match(/-h\s+["']?([^\s"']+)/)?.[1] ?? null },
  { cmd: /^wpscan\s/, extract: (a) => {
    const u = a.match(/--url\s+["']?([^\s"']+)/)?.[1];
    return u ? hostFromUrl(u) : null;
  } },
  { cmd: /^nuclei\s/, extract: (a) => {
    const u = a.match(/-u\s+["']?([^\s"']+)/)?.[1];
    return u ? hostFromUrl(u) : null;
  } },
  { cmd: /^hydra\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^crackmapexec\s|^cme\s|^netexec\s|^nxc\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^evil-winrm\s/, extract: (a) => a.match(/-i\s+([^\s]+)/)?.[1] ?? null },
  { cmd: /^impacket-|^python3?\s.*impacket/, extract: (a) => a.match(/@([^\s/:]+)/)?.[1] ?? lastIPOrDomain(a) },
  { cmd: /^nc\s|^ncat\s|^socat\s/, extract: (a) => a.match(IP_RE)?.[1] ?? a.match(DOMAIN_RE)?.[1] ?? null },
  { cmd: /^ping\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^traceroute\s/, extract: (a) => lastIPOrDomain(a) },
  { cmd: /^dig\s/, extract: (a) => {
    const parts = a.trim().split(/\s+/);
    return parts.find((p) => DOMAIN_RE.test(p) && !p.startsWith("-") && !p.startsWith("@")) ?? null;
  } },
  { cmd: /^ldapsearch\s/, extract: (a) => a.match(/-[hH]\s+([^\s]+)/)?.[1] ?? null },
  { cmd: /^bloodhound-python\s|^bloodhound\s/, extract: (a) => a.match(/-d\s+([^\s]+)/)?.[1] ?? null },
  { cmd: /^set\s+RHOSTS?\s/i, extract: (a) => a.match(/RHOSTS?\s+([^\s]+)/i)?.[1] ?? null },
  // Internal-network pivots — catalog the node reached through the pivot.
  { cmd: /^proxychains4?\s/, extract: (a) => lastIPOrDomain(a.replace(/^proxychains4?\s+(-q\s+|-f\s+\S+\s+)*/, "")) },
  { cmd: /^sshuttle\s/, extract: (a) => a.match(/-r\s+(?:[^@\s]+@)?([^\s]+)/)?.[1] ?? null },
  { cmd: /^chisel\s/, extract: (a) => a.match(/client\s+(?:https?:\/\/)?([^\s:/]+)/)?.[1] ?? null },
  { cmd: /ligolo|(^|\s)agent\s+.*-connect/, extract: (a) => a.match(/-connect\s+([^\s:]+)/)?.[1] ?? null }
];
function hostFromUrl(url2) {
  try {
    return new URL(url2.startsWith("http") ? url2 : `http://${url2}`).hostname;
  } catch {
    return url2.match(URL_RE)?.[1] ?? null;
  }
}
function extractUrlHost(args) {
  const urlMatch = args.match(URL_RE);
  if (urlMatch) return urlMatch[1];
  return args.match(IP_RE)?.[1] ?? args.match(DOMAIN_RE)?.[1] ?? null;
}
function lastIPOrDomain(args) {
  const tokens = args.trim().split(/\s+/).filter((t) => !t.startsWith("-"));
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (IP_RE.test(tokens[i])) return tokens[i].match(IP_RE)[1];
    if (DOMAIN_RE.test(tokens[i])) return tokens[i].match(DOMAIN_RE)[1];
  }
  return null;
}
const externalPatterns = [];
function registerTargetExtractors(pluginId, extractors) {
  let added = 0;
  for (const e of extractors) {
    try {
      externalPatterns.push({ cmd: new RegExp(e.cmd), extract: new RegExp(e.extract, e.flags), pluginId });
      added++;
    } catch {
    }
  }
  return added;
}
function unregisterTargetExtractors(pluginId) {
  for (let i = externalPatterns.length - 1; i >= 0; i--) {
    if (externalPatterns[i].pluginId === pluginId) externalPatterns.splice(i, 1);
  }
}
function extractTarget(command) {
  const trimmed = command.trim();
  for (const p of externalPatterns) {
    if (p.cmd.test(trimmed)) {
      const m = trimmed.match(p.extract);
      if (m) return m[1] ?? m[0];
    }
  }
  for (const pattern of PATTERNS) {
    if (pattern.cmd.test(trimmed)) {
      return pattern.extract(trimmed);
    }
  }
  return extractUrlHost(trimmed) ?? null;
}
const IP_OR_HOST = /([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+|\d{1,3}(?:\.\d{1,3}){3})/;
const CIDR = /\b(\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2})\b/;
const T_PROXY = "T1090";
const T_TUNNEL = "T1572";
function detectPivot(command) {
  const cmd = command.trim();
  const first = cmd.split(/\s+/)[0]?.split(/[\\/]/).pop() ?? "";
  const isLigolo = /ligolo/.test(first) || (first === "agent" || first === "proxy") && /-connect|-selfcert|-relay/.test(cmd);
  if (isLigolo) {
    const connect = cmd.match(/-connect\s+([^\s]+)/);
    if (connect) return { tool: "ligolo-ng", subtype: "agent_connect", via: connect[1].replace(/:\d+$/, ""), mitreTtp: T_TUNNEL };
    if (/-selfcert/.test(cmd) || first === "proxy") return { tool: "ligolo-ng", subtype: "tunnel_start", mitreTtp: T_TUNNEL };
  }
  if (first === "chisel") {
    const server2 = cmd.match(/client\s+(?:https?:\/\/)?([^\s]+)/);
    const rspec = cmd.match(/\bR:([^\s]+)/);
    if (rspec) return { tool: "chisel", subtype: /socks/i.test(rspec[1]) ? "socks_up" : "port_forward", via: server2?.[1]?.replace(/:\d+$/, ""), forward: rspec[1], mitreTtp: T_TUNNEL };
    if (server2) return { tool: "chisel", subtype: "tunnel_start", via: server2[1].replace(/:\d+$/, ""), mitreTtp: T_TUNNEL };
  }
  if (first === "sshuttle") {
    const jump = cmd.match(/-r\s+(?:[^@\s]+@)?([^\s]+)/);
    const route = cmd.match(CIDR);
    return { tool: "sshuttle", subtype: "route_add", via: jump?.[1], route: route?.[1], mitreTtp: T_PROXY };
  }
  if (first === "proxychains" || first === "proxychains4") {
    const rest = cmd.replace(/^proxychains4?\s+(-q\s+|-f\s+\S+\s+)*/, "");
    const target = rest.match(IP_OR_HOST);
    return { tool: "proxychains", subtype: "proxied", via: target?.[1], mitreTtp: T_PROXY };
  }
  if (first === "ssh" || first === "autossh") {
    const host2 = cmd.match(/(?:[^@\s]+@)([^\s]+)/)?.[1] ?? cmd.trim().split(/\s+/).pop();
    const d = cmd.match(/-D\s*(\d+)/);
    if (d) return { tool: "ssh", subtype: "socks_up", via: host2, socksPort: Number(d[1]), mitreTtp: T_PROXY };
    const l = cmd.match(/-[LR]\s*([^\s]+)/);
    if (l) return { tool: "ssh", subtype: "port_forward", via: host2, forward: l[1], mitreTtp: T_TUNNEL };
  }
  if (first === "socat" && /LISTEN/i.test(cmd) && /TCP:|TCP4:|TCP6:/i.test(cmd)) {
    const to = cmd.match(/TCP[46]?:([^\s,]+)/i);
    return { tool: "socat", subtype: "port_forward", via: to?.[1]?.replace(/:\d+$/, ""), forward: to?.[1], mitreTtp: T_TUNNEL };
  }
  return null;
}
const noArgs = { type: "object", properties: {}, required: [] };
const MCP_TOOLS = [
  { name: "redlog_status", description: "Get RedLog status: IP state, event count, scope violations.", inputSchema: noArgs },
  {
    name: "redlog_mark",
    description: "Create a timestamped marker in the RedLog timeline. Use for key moments: found a vuln, started a new phase, noted something worth recording.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: 'What happened (e.g. "Found SQLi in /api/users")' },
        notes: { type: "string", description: "Additional context or details" },
        severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"], description: "Severity level" },
        target: { type: "string", description: "Target host/IP this relates to" }
      },
      required: ["title"]
    }
  },
  {
    name: "redlog_log_event",
    description: "Log a raw event with custom agent_type and data — only for actions no hook captured (GUI clicks, manual observations). Do NOT use for shell commands the hooks already log. Prefer standard agent_type (shell, agent, scanner, dns, credential_use, c2_checkin, file_transfer, pivot) and standard data keys (subtype, tool, dest_ip, dest_host, dest_port, user_context, mitre_ttp, description, sha256, bytes; for pivot: via, route, socks_port, forward). See docs/event-schema.md.",
    inputSchema: {
      type: "object",
      properties: {
        agent_type: { type: "string", description: "Event source type. Prefer: agent / scanner / dns / credential_use / c2_checkin / file_transfer" },
        data: { type: "object", description: "Event payload. Populate standard keys when applicable.", additionalProperties: true },
        target: { type: "string", description: "Target host/IP (also written to target_id for filter/scope match)" }
      },
      required: ["agent_type", "data"]
    }
  },
  {
    name: "redlog_search",
    description: "Search across all RedLog events (commands, targets, clipboard, loot) by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (min 2 chars)" },
        limit: { type: "number", description: "Max results (default 20)" }
      },
      required: ["query"]
    }
  },
  {
    name: "redlog_events",
    description: "Query recent timeline events, optionally filtered by type or target.",
    inputSchema: {
      type: "object",
      properties: {
        agent_type: { type: "string", description: "Filter by type: shell, dns, screenshot, marker, loot, system, …" },
        target: { type: "string", description: "Filter by target host/IP" },
        limit: { type: "number", description: "Max results (default 50)" }
      },
      required: []
    }
  },
  { name: "redlog_scope", description: "Get the current scope configuration: in-scope targets, exclusions, and violations.", inputSchema: noArgs },
  { name: "redlog_config", description: "Get the current RedLog project configuration (engagement, operator, network, scope).", inputSchema: noArgs },
  {
    name: "redlog_quickmark",
    description: "Create a QuickMark bookmark for the current finding or interesting URL.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Bookmark title" },
        url: { type: "string", description: "URL to bookmark" },
        note: { type: "string", description: "Notes about this bookmark" }
      },
      required: ["title"]
    }
  },
  { name: "redlog_quickmarks_list", description: "List all QuickMark bookmarks in the current project.", inputSchema: noArgs },
  {
    name: "redlog_loot_scan",
    description: "Scan text for credentials, secrets, API keys, JWTs, password hashes, and other loot.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "Text to scan for secrets/credentials" } },
      required: ["text"]
    }
  },
  { name: "redlog_screenshot", description: "Capture a screenshot of the current desktop.", inputSchema: noArgs },
  {
    name: "redlog_recording",
    description: "Control recording state: check, pause, resume, or toggle.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["status", "pause", "resume", "toggle"], description: "Action to perform" } },
      required: ["action"]
    }
  },
  { name: "redlog_whoami", description: "Return the operator identity this token resolves to. Every event is attributed to this operator.", inputSchema: noArgs },
  { name: "redlog_operators_list", description: "List every operator token registered on this RedLog instance.", inputSchema: noArgs },
  { name: "redlog_chain_status", description: "Return the evidence-chain length and the latest OpenTimestamps anchor status.", inputSchema: noArgs },
  { name: "redlog_chain_anchor_now", description: "Submit the current chain head to OpenTimestamps calendars now. Use before ending a session or after a critical finding.", inputSchema: noArgs },
  { name: "redlog_chain_verify", description: "Quick integrity check: confirm the latest anchor still describes a prefix of the current chain.", inputSchema: noArgs },
  {
    name: "redlog_chain_upgrade",
    description: "Fetch upgraded OpenTimestamps proofs for pending anchors (wait a few hours after anchoring). Omit anchor_id to upgrade all pending.",
    inputSchema: {
      type: "object",
      properties: { anchor_id: { type: "string", description: "Specific anchor id. Omit to upgrade all pending." } },
      required: []
    }
  }
];
const MCP_PROTOCOL_VERSION = "2024-11-05";
async function handleMcpMessage(msg, opts) {
  const id = msg.id ?? null;
  switch (msg.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "redlog", version: opts.version }
        }
      };
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: [...MCP_TOOLS, ...opts.extraTools ?? []] } };
    case "tools/call": {
      const name = msg.params?.name ?? "";
      const args = msg.params?.arguments ?? {};
      try {
        const result = await opts.dispatch(name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] }
        };
      } catch (e) {
        return {
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true }
        };
      }
    }
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    default:
      if (msg.id === void 0 || msg.id === null) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}
const byPlugin = /* @__PURE__ */ new Map();
function toolName(pluginId, name) {
  const clean = name.replace(/[^a-z0-9_]/gi, "_");
  return clean.startsWith(`${pluginId}_`) ? clean : `${pluginId.replace(/-/g, "_")}_${clean}`;
}
function registerPluginTools(pluginId, tools, dispatch) {
  byPlugin.set(pluginId, {
    tools: tools.map((tdef) => ({ ...tdef, name: toolName(pluginId, tdef.name), pluginId })),
    dispatch
  });
}
function unregisterPluginTools(pluginId) {
  byPlugin.delete(pluginId);
}
function listPluginTools() {
  return [...byPlugin.values()].flatMap((e) => e.tools);
}
async function dispatchPluginTool(name, args) {
  for (const entry of byPlugin.values()) {
    const tool = entry.tools.find((t) => t.name === name);
    if (tool) return { owned: true, result: await entry.dispatch(name, args) };
  }
  return { owned: false };
}
const CAP_FOR_METHOD = {
  "events.query": "read:events",
  "events.search": "read:events",
  "events.append": "write:events",
  "findings.list": "read:findings",
  "config.get": "read:config",
  "net.fetch": "net:outbound"
};
function methodAllowed(method, granted) {
  const need = CAP_FOR_METHOD[method];
  if (!need) return false;
  return granted.includes(need);
}
const HOOKS_DIR = path.join(__dirname, "../../../hooks");
const SHELL_DIR = path.join(__dirname, "../../../shell");
function resolveDir(primary, fallback) {
  return fs.existsSync(primary) ? primary : fallback;
}
const PLUGIN_REGISTRY = [
  {
    id: "claude-code",
    name: "Claude Code",
    description: "Captures Bash tool calls from Claude Code sessions",
    agentType: "shell",
    requires: ["claude"],
    hookFile: "hooks/claude-code-hook.sh",
    installMethod: "claude-settings",
    claudeSettingsMatcher: "claude-code-hook"
  },
  {
    id: "shell-zsh",
    name: "Zsh Shell",
    description: "Captures commands and exit codes from zsh",
    agentType: "shell",
    requires: [],
    hookFile: "shell/redlog-hook.zsh",
    installMethod: "shell-source",
    installTarget: path.join(os.homedir(), ".redlog", "shell-hook.zsh"),
    shellRcFile: ".zshrc"
  },
  {
    id: "shell-bash",
    name: "Bash Shell",
    description: "Captures commands via preexec/precmd hooks",
    agentType: "shell",
    requires: [],
    hookFile: "hooks/shell-preexec-hook.sh",
    installMethod: "shell-source",
    installTarget: path.join(os.homedir(), ".redlog", "shell-preexec-hook.sh"),
    shellRcFile: ".bashrc"
  },
  {
    id: "codex",
    name: "Codex",
    description: "Wraps Codex shell to capture agent commands",
    agentType: "shell",
    requires: ["codex"],
    hookFile: "hooks/codex-wrapper.sh",
    installMethod: "manual"
  },
  {
    id: "mitmproxy",
    name: "mitmproxy",
    description: "Captures HTTP traffic via mitmproxy addon",
    agentType: "http",
    requires: ["mitmproxy", "mitmdump"],
    hookFile: "hooks/mitmproxy-addon.py",
    installMethod: "manual"
  },
  {
    id: "shell-powershell",
    name: "PowerShell",
    description: "Captures commands from PowerShell via prompt hook",
    agentType: "shell",
    requires: [],
    hookFile: "hooks/shell-hook.ps1",
    installMethod: "manual"
  },
  {
    id: "shell-wsl",
    name: "WSL (Bash)",
    description: "Captures commands from WSL bash sessions — auto-resolves Windows token path",
    agentType: "shell",
    requires: [],
    hookFile: "hooks/shell-preexec-hook.sh",
    installMethod: "manual"
  }
];
const externalCaptures = [];
function registerCapturePlugins(pluginId, dir, entries) {
  for (const e of entries) {
    const id = e.id.startsWith(`${pluginId}.`) ? e.id : `${pluginId}.${e.id}`;
    externalCaptures.push({ ...e, id, requires: e.requires ?? [], _dir: dir });
  }
}
function unregisterCapturePlugins(pluginId) {
  for (let i = externalCaptures.length - 1; i >= 0; i--) {
    if (externalCaptures[i].id.startsWith(`${pluginId}.`)) externalCaptures.splice(i, 1);
  }
}
function allManifests() {
  return [...PLUGIN_REGISTRY, ...externalCaptures];
}
function srcPathFor(plugin) {
  if (plugin._dir) return path.join(plugin._dir, plugin.hookFile);
  const hooksDir = resolveDir(HOOKS_DIR, path.join(__dirname, "../../hooks"));
  const shellDir = resolveDir(SHELL_DIR, path.join(__dirname, "../../shell"));
  return plugin.hookFile.startsWith("shell/") ? path.join(shellDir, plugin.hookFile.replace("shell/", "")) : path.join(hooksDir, plugin.hookFile.replace("hooks/", ""));
}
function installTargetFor(plugin) {
  if (plugin.installTarget) return plugin.installTarget;
  const base = plugin.hookFile.split(/[\\/]/).pop() ?? `${plugin.id}.sh`;
  return path.join(os.homedir(), ".redlog", base);
}
function shellRcFor(plugin) {
  if (plugin.shellRcFile) return plugin.shellRcFile;
  return process.env.SHELL?.includes("zsh") ? ".zshrc" : ".bashrc";
}
function commandExists(cmd) {
  try {
    const probe = process.platform === "win32" ? `where ${cmd}` : `which ${cmd}`;
    child_process.execSync(probe, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function isClaudeSettingsInstalled(matcher) {
  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const hooks = settings?.hooks?.PostToolUse;
    if (!Array.isArray(hooks)) return false;
    return hooks.some(
      (h) => h.hooks?.some((hk) => hk.command?.includes(matcher))
    );
  } catch {
    return false;
  }
}
function isShellSourceInstalled(rcFile, hookPath) {
  if (!fs.existsSync(hookPath)) return false;
  const rcPath = path.join(os.homedir(), rcFile);
  if (!fs.existsSync(rcPath)) return false;
  const content = fs.readFileSync(rcPath, "utf-8");
  const hookName = hookPath.split(/[\\/]/).pop() ?? "";
  return content.includes(hookName);
}
function matcherFor(plugin) {
  return plugin.claudeSettingsMatcher ?? (plugin._dir ? plugin.hookFile.split(/[\\/]/).pop() ?? plugin.id : plugin.id);
}
function checkInstalled(plugin) {
  switch (plugin.installMethod) {
    case "claude-settings":
      return isClaudeSettingsInstalled(matcherFor(plugin));
    case "shell-source":
      return isShellSourceInstalled(plugin.shellRcFile ?? ".zshrc", installTargetFor(plugin));
    case "manual":
      return false;
  }
}
function checkAvailable(plugin) {
  if (plugin.requires.length === 0) {
    if (plugin.id === "shell-powershell") return process.platform === "win32";
    if (plugin.id === "shell-wsl") {
      if (process.platform !== "win32") return false;
      try {
        child_process.execSync("where wsl", { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    }
    if (plugin.id === "shell-zsh") return process.env.SHELL?.includes("zsh") || fs.existsSync("/bin/zsh");
    if (plugin.id === "shell-bash") {
      return fs.existsSync("/bin/bash") || process.platform === "win32" && commandExists("bash");
    }
    return true;
  }
  return plugin.requires.some((cmd) => commandExists(cmd));
}
function buildManualSteps(pluginId, hookFile) {
  switch (pluginId) {
    case "mitmproxy":
      return [
        {
          label: "Start mitmproxy with the RedLog addon (keep it running during the engagement)",
          command: `mitmdump -s "${hookFile}"`
        },
        {
          label: "Route traffic through it — proxy your browser/tools at 127.0.0.1:8080, or use Launch Browser in RedLog which wires the proxy for you"
        }
      ];
    case "codex":
      if (process.platform === "win32") {
        return [
          {
            label: "The Codex wrapper is a bash script — run it inside WSL or Git Bash (cmd/PowerShell cannot execute it). Inside that shell, use the same commands shown on macOS/Linux, adjusting the path for that environment."
          }
        ];
      }
      return [
        {
          label: "Wrap a whole shell the agent will use — every command it runs is captured",
          command: `"${hookFile}"`
        },
        {
          label: "Or point Codex CLI at the wrapper as its shell",
          command: `SHELL="${hookFile}" codex run "scan the target"`
        }
      ];
    case "shell-powershell":
      return [
        {
          label: "Add to your PowerShell profile so it loads on every session",
          command: `Add-Content $PROFILE '. "${hookFile}"'`
        },
        {
          label: "Or source it manually in the current session",
          command: `. "${hookFile}"`
        }
      ];
    case "shell-wsl": {
      const wslHookPath = hookFile.replace(/\\/g, "/").replace(/^([A-Z]):/, (_m, d) => `/mnt/${d.toLowerCase()}`);
      return [
        {
          label: "Add to your WSL ~/.bashrc so it loads on every session",
          command: `echo 'source "${wslHookPath}"' >> ~/.bashrc`
        },
        {
          label: "Or source it manually in the current WSL session",
          command: `source "${wslHookPath}"`
        }
      ];
    }
    default:
      return void 0;
  }
}
function detectHooks() {
  return allManifests().map((plugin) => {
    const hookFile = srcPathFor(plugin);
    const manualSteps = plugin.installMethod === "manual" ? plugin.manualSteps ?? buildManualSteps(plugin.id, hookFile) : void 0;
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      agentType: plugin.agentType,
      installed: checkInstalled(plugin),
      available: checkAvailable(plugin),
      installMethod: plugin.installMethod,
      hookFile,
      manualSteps
    };
  });
}
function installHook(pluginId) {
  const plugin = allManifests().find((p) => p.id === pluginId);
  if (!plugin) return { success: false, message: `Unknown plugin: ${pluginId}` };
  switch (plugin.installMethod) {
    case "claude-settings": {
      const hookFile = srcPathFor(plugin);
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      try {
        fs.mkdirSync(path.join(os.homedir(), ".claude"), { recursive: true });
        let settings = {};
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        }
        if (!settings.hooks) settings.hooks = {};
        const hooks = settings.hooks;
        if (!hooks.PostToolUse) hooks.PostToolUse = [];
        const postTool = hooks.PostToolUse;
        const matcher = matcherFor(plugin);
        const exists = postTool.some(
          (h) => h.hooks?.some((hk) => hk.command?.includes(matcher))
        );
        if (!exists) {
          postTool.push({
            matcher: "Bash",
            hooks: [{ command: fs.existsSync(hookFile) ? hookFile : `redlog-hooks/${plugin.hookFile.replace("hooks/", "")}` }]
          });
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return { success: true, message: `${plugin.name} hook added to ~/.claude/settings.json` };
      } catch (e) {
        return { success: false, message: `Failed: ${e}` };
      }
    }
    case "shell-source": {
      try {
        const dest = installTargetFor(plugin);
        const src = srcPathFor(plugin);
        fs.mkdirSync(path.join(os.homedir(), ".redlog"), { recursive: true });
        if (fs.existsSync(src)) fs.copyFileSync(src, dest);
        const rcFile = shellRcFor(plugin);
        const rcPath = path.join(os.homedir(), rcFile);
        let content = fs.existsSync(rcPath) ? fs.readFileSync(rcPath, "utf-8") : "";
        const hookName = dest.split(/[\\/]/).pop();
        if (!content.includes(hookName)) {
          content += `
# RedLog shell hook
source ${dest}
`;
          fs.writeFileSync(rcPath, content);
        }
        return { success: true, message: `${plugin.name} hook installed. Run: source ~/${rcFile}` };
      } catch (e) {
        return { success: false, message: `Failed: ${e}` };
      }
    }
    case "manual":
      return { success: false, message: `Manual setup required for ${plugin.name}` };
  }
}
function uninstallHook(pluginId) {
  const plugin = allManifests().find((p) => p.id === pluginId);
  if (!plugin) return { success: false, message: `Unknown plugin: ${pluginId}` };
  switch (plugin.installMethod) {
    case "claude-settings": {
      const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
      try {
        if (!fs.existsSync(settingsPath)) return { success: true, message: "Already removed" };
        const settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
        const postTool = settings?.hooks?.PostToolUse;
        const matcher = matcherFor(plugin);
        if (postTool) {
          settings.hooks.PostToolUse = postTool.filter(
            (h) => !h.hooks?.some((hk) => hk.command?.includes(matcher))
          );
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        return { success: true, message: `${plugin.name} hook removed` };
      } catch (e) {
        return { success: false, message: `Failed: ${e}` };
      }
    }
    case "shell-source": {
      try {
        const rcFile = shellRcFor(plugin);
        const rcPath = path.join(os.homedir(), rcFile);
        const dest = installTargetFor(plugin);
        if (fs.existsSync(rcPath)) {
          let content = fs.readFileSync(rcPath, "utf-8");
          const escapedDest = dest.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          content = content.replace(new RegExp(`\\n?# RedLog shell hook\\nsource ${escapedDest}\\n?`, "g"), "\n");
          fs.writeFileSync(rcPath, content);
        }
        return { success: true, message: `${plugin.name} hook removed. Run: source ~/${rcFile}` };
      } catch (e) {
        return { success: false, message: `Failed: ${e}` };
      }
    }
    case "manual":
      return { success: false, message: `Manual removal required for ${plugin.name}` };
  }
}
const ACTIVE_WINDOW_MS = 10 * 60 * 1e3;
function lastEventFor(where, params = []) {
  const db2 = getDB();
  const row = db2.prepare(
    `SELECT MAX(timestamp) AS t FROM events WHERE ${where}`
  ).get(...params);
  return row?.t ?? null;
}
function stateFrom(installed, last, now) {
  if (installed === false) return "absent";
  if (last !== null && now - last <= ACTIVE_WINDOW_MS) return "active";
  return "idle";
}
let hooksCache = null;
const HOOKS_TTL_MS = 15e3;
function cachedHooks(now) {
  if (hooksCache && now - hooksCache.at < HOOKS_TTL_MS) return hooksCache.value;
  let value = [];
  try {
    value = detectHooks();
  } catch {
  }
  hooksCache = { at: now, value };
  return value;
}
function invalidateHooksCache() {
  hooksCache = null;
}
function getCaptureHealth(now = Date.now()) {
  const hooks = cachedHooks(now);
  const hookInstalled = (id) => hooks.find((h) => h.id === id)?.installed;
  const claudeLast = lastEventFor(`agent_type = 'agent' AND data LIKE '%claude_code_bash%'`);
  const shellHookLast = lastEventFor(
    `agent_type = 'shell' AND json_extract(data,'$.subtype') IN ('command_start','command_end') AND coalesce(json_extract(data,'$.source'),'') != 'builtin-terminal'`
  );
  const mitmLast = lastEventFor(`agent_type = 'scanner'`);
  const builtinLast = lastEventFor(`agent_type = 'shell' AND json_extract(data,'$.source') = 'builtin-terminal'`);
  const sources = [
    { id: "shell-hook", installed: hookInstalled("shell-zsh") ?? hookInstalled("shell-bash") ?? hookInstalled("shell-powershell"), lastEventAt: shellHookLast, state: stateFrom(hookInstalled("shell-zsh") ?? hookInstalled("shell-bash") ?? hookInstalled("shell-powershell"), shellHookLast, now) },
    { id: "claude-code", installed: hookInstalled("claude-code"), lastEventAt: claudeLast, state: stateFrom(hookInstalled("claude-code"), claudeLast, now) },
    { id: "mitmproxy", installed: void 0, lastEventAt: mitmLast, state: stateFrom(void 0, mitmLast, now) },
    { id: "builtin-terminal", installed: void 0, lastEventAt: builtinLast, state: stateFrom(void 0, builtinLast, now) }
  ];
  const activeCount = sources.filter((s) => s.state === "active").length;
  const everFed = sources.some((s) => s.lastEventAt !== null);
  const anyWired = sources.some((s) => s.installed === true) || sources.some((s) => s.installed === void 0 && s.lastEventAt !== null);
  let verdict;
  if (!anyWired && !everFed) verdict = "dark";
  else if (activeCount === 0) verdict = "partial";
  else verdict = "healthy";
  const lastEventAt = sources.reduce(
    (acc, s) => s.lastEventAt !== null && (acc === null || s.lastEventAt > acc) ? s.lastEventAt : acc,
    null
  );
  return { verdict, recording: everFed, sources, lastEventAt, checkedAt: now };
}
let appVersion = "dev";
function setAppVersion(v) {
  appVersion = v;
}
const TOKEN_PATH = path.join(os.homedir(), ".redlog", "api-token");
const PORT_PATH = path.join(os.homedir(), ".redlog", "api-port");
let server = null;
let primaryToken = "";
let listeningPort = 6660;
let engagementId$1 = "default";
let primaryOperatorId = "";
let primaryOperatorName = "";
let configLoaderRef = null;
let lootDetectorRef = null;
let screenshotAgentRef = null;
let ipMonitorRef = null;
let scopeMonitorRef = null;
function configureApi(opts) {
  engagementId$1 = opts.engagementId;
  primaryOperatorId = opts.operatorId;
  if (opts.operatorName) primaryOperatorName = opts.operatorName;
  if (opts.configLoader) configLoaderRef = opts.configLoader;
  if (opts.lootDetector) lootDetectorRef = opts.lootDetector;
  if (opts.screenshotAgent) screenshotAgentRef = opts.screenshotAgent;
  if (opts.ipMonitor) ipMonitorRef = opts.ipMonitor;
  if (opts.scopeMonitor) scopeMonitorRef = opts.scopeMonitor;
}
function makeMcpDispatch(operator) {
  const attributed = { engagementId: engagementId$1, operatorId: operator.id };
  return async (name, args) => {
    switch (name) {
      case "redlog_status":
        return {
          ip: ipMonitorRef?.status ?? null,
          eventCount: getEventCount(),
          scopeViolations: scopeMonitorRef?.getViolationCount() ?? 0,
          capture: getCaptureHealth()
        };
      case "redlog_whoami":
        return { operator: publicOperator(operator), engagementId: engagementId$1 };
      case "redlog_operators_list":
        return { operators: listOperators().map(publicOperator) };
      case "redlog_mark": {
        const event = insertEvent("marker", {
          title: args.title ?? "Untitled",
          notes: args.notes ?? "",
          severity: args.severity ?? "info",
          category: "mcp"
        }, { ...attributed, targetId: args.target });
        if (event) eventBus.publish(event);
        return event;
      }
      case "redlog_log_event": {
        const data = args.data ?? {};
        const event = insertEvent(
          args.agent_type || "agent",
          data,
          { ...attributed, targetId: args.target }
        );
        if (event) eventBus.publish(event);
        return event;
      }
      case "redlog_search":
        return { events: searchEvents(String(args.query ?? ""), Number(args.limit) || 20) };
      case "redlog_events":
        return {
          events: queryEvents({
            agentType: args.agent_type,
            targetId: args.target,
            limit: Number(args.limit) || 50
          })
        };
      case "redlog_scope":
        return {
          targets: configLoaderRef?.getTargets() ?? [],
          violations: scopeMonitorRef?.getViolations() ?? [],
          violationCount: scopeMonitorRef?.getViolationCount() ?? 0
        };
      case "redlog_config":
        return configLoaderRef?.getConfig() ?? {};
      case "redlog_quickmark":
        return createQuickMark({
          title: args.title || "Untitled",
          url: args.url,
          note: args.note || "",
          context: {}
        });
      case "redlog_quickmarks_list":
        return { quickmarks: listQuickMarks() };
      case "redlog_loot_scan": {
        if (!lootDetectorRef) return { findings: [] };
        return { findings: lootDetectorRef.scan(String(args.text ?? "")) };
      }
      case "redlog_screenshot": {
        if (!screenshotAgentRef) return { captured: false };
        const filePath = await screenshotAgentRef.captureNow("mcp");
        return { captured: !!filePath, filePath };
      }
      case "redlog_recording": {
        const action = args.action;
        if (action === "pause") eventBus.pause();
        else if (action === "resume") eventBus.resume();
        else if (action === "toggle") {
          if (eventBus.paused) eventBus.resume();
          else eventBus.pause();
        }
        return { recording: !eventBus.paused };
      }
      case "redlog_chain_status":
        return { length: getChainLength(), lastAnchor: listAnchors(1)[0] ?? null };
      case "redlog_chain_anchor_now":
        return { anchor: await anchorNow() };
      case "redlog_chain_verify":
        return verifyLatestAnchor();
      case "redlog_chain_upgrade":
        return args.anchor_id ? { anchor: await upgradeAnchor(String(args.anchor_id)) } : await upgradeAllPending();
      default: {
        const plug = await dispatchPluginTool(name, args);
        if (plug.owned) return plug.result;
        throw new Error(`Unknown tool: ${name}`);
      }
    }
  };
}
function writePrimaryToken() {
  const token = generateToken();
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, token, { mode: 384 });
  primaryToken = token;
  return token;
}
function writePort(port) {
  fs.writeFileSync(PORT_PATH, String(port), { mode: 384 });
}
function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const parts = header.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1];
}
function authenticate(req) {
  const token = extractBearerToken(req);
  if (!token) return null;
  return resolveOperatorByToken(token);
}
function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
function publicOperator(op) {
  return {
    id: op.id,
    name: op.name,
    isPrimary: op.isPrimary,
    createdAt: op.createdAt,
    revokedAt: op.revokedAt
  };
}
async function handleRequest(req, res) {
  const url2 = new URL(req.url || "/", `http://localhost`);
  const route = url2.pathname;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (route === "/api/health" && req.method === "GET") {
    json(res, 200, { ok: true, version: "0.6.2" });
    return;
  }
  const operator = authenticate(req);
  if (!operator) {
    json(res, 401, { error: "Unauthorized. Set Authorization: Bearer <token>" });
    return;
  }
  try {
    if ((route === "/mcp" || route === "/api/mcp") && req.method === "POST") {
      const parsed = JSON.parse(await readBody(req));
      const dispatch = makeMcpDispatch(operator);
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const extraTools = listPluginTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      const responses = (await Promise.all(
        messages.map((m) => handleMcpMessage(m, { version: appVersion, dispatch, extraTools }))
      )).filter((r) => r !== null);
      if (responses.length === 0) {
        res.writeHead(202);
        res.end();
        return;
      }
      json(res, 200, Array.isArray(parsed) ? responses : responses[0]);
      return;
    }
    if (route === "/api/whoami" && req.method === "GET") {
      json(res, 200, { operator: publicOperator(operator), engagementId: engagementId$1 });
      return;
    }
    if (route === "/api/events" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const agentType = body.agent_type || body.agentType || "external";
      const data = body.data || {};
      let targetId = body.target_id || body.targetId || void 0;
      let lootValues = [];
      let pivot = null;
      if (agentType === "shell" && data.command) {
        const cmd = data.command;
        const isStart = data.subtype === "command_start";
        const detected = extractTarget(cmd);
        if (detected) {
          data.detectedTarget = detected;
          if (!targetId) targetId = detected;
        }
        if (isStart && detected && scopeMonitorRef) {
          scopeMonitorRef.checkTarget(detected, cmd);
        }
        if (isStart) pivot = detectPivot(cmd);
        if (!isStart && lootDetectorRef) {
          const textToScan = [cmd, data.output].filter(Boolean).join("\n");
          if (textToScan) {
            const matches = lootDetectorRef.scan(textToScan, targetId);
            lootValues = matches.map((m) => m.value).filter((v) => v && v.length >= 6);
          }
        }
      }
      const baseRules = getRules();
      const perEventRules = lootValues.length > 0 ? { ...baseRules, denylist: [...baseRules.denylist, ...lootValues] } : baseRules;
      for (const field of ["output", "output_preview"]) {
        if (typeof data[field] === "string" && data[field]) {
          const result = redact(data[field], perEventRules);
          data[field] = result.text;
          if (result.redacted.length > 0) {
            const redactions = data.redactions ?? [];
            data.redactions = [...redactions, ...result.redacted.map((r) => ({ ...r, field }))];
          }
        }
      }
      const event = insertEvent(agentType, data, {
        engagementId: engagementId$1,
        operatorId: operator.id,
        targetId
      });
      if (!event) {
        json(res, 409, { error: "Duplicate event (dedup window)" });
        return;
      }
      eventBus.publish(event);
      if (pivot) {
        try {
          const pv = insertEvent("pivot", {
            subtype: pivot.subtype,
            tool: pivot.tool,
            via: pivot.via,
            route: pivot.route,
            socks_port: pivot.socksPort,
            forward: pivot.forward,
            mitre_ttp: pivot.mitreTtp,
            command: data.command,
            description: `Pivot via ${pivot.tool}${pivot.via ? ` → ${pivot.via}` : ""}${pivot.route ? ` (${pivot.route})` : ""}`
          }, { engagementId: engagementId$1, operatorId: operator.id, targetId: pivot.via ?? targetId });
          if (pv) eventBus.publish(pv);
        } catch {
        }
      }
      json(res, 201, event);
      return;
    }
    if (route === "/api/events" && req.method === "GET") {
      const agentType = url2.searchParams.get("agent_type") || void 0;
      const limit = parseInt(url2.searchParams.get("limit") || "100");
      const since = url2.searchParams.get("since") ? parseInt(url2.searchParams.get("since")) : void 0;
      const targetId = url2.searchParams.get("target_id") || void 0;
      const events2 = queryEvents({ agentType, limit, since, targetId });
      json(res, 200, { count: events2.length, events: events2 });
      return;
    }
    if (route === "/api/events/search" && req.method === "GET") {
      const q = url2.searchParams.get("q") || "";
      const limit = parseInt(url2.searchParams.get("limit") || "100");
      if (q.length < 2) {
        json(res, 400, { error: "Query must be at least 2 characters" });
        return;
      }
      const events2 = searchEvents(q, limit);
      json(res, 200, { count: events2.length, events: events2 });
      return;
    }
    if (route === "/api/events/count" && req.method === "GET") {
      json(res, 200, { count: getEventCount() });
      return;
    }
    if (route === "/api/marker" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const event = insertEvent("marker", {
        title: body.title || "Untitled",
        notes: body.notes || "",
        severity: body.severity || "info",
        category: body.category || "external"
      }, { engagementId: engagementId$1, operatorId: operator.id, targetId: body.target_id || body.targetId });
      if (event) eventBus.publish(event);
      json(res, 201, event);
      return;
    }
    if (route === "/api/loot/scan" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (!lootDetectorRef) {
        json(res, 503, { error: "Loot detector not available" });
        return;
      }
      const findings = lootDetectorRef.scan(body.text || "");
      json(res, 200, { findings });
      return;
    }
    if (route === "/api/screenshot" && req.method === "POST") {
      if (!screenshotAgentRef) {
        json(res, 503, { error: "Screenshot agent not available" });
        return;
      }
      const filePath = await screenshotAgentRef.captureNow("api");
      json(res, 200, { captured: !!filePath, filePath });
      return;
    }
    if (route === "/api/status" && req.method === "GET") {
      json(res, 200, {
        ip: ipMonitorRef?.status || null,
        eventCount: getEventCount(),
        scopeViolations: scopeMonitorRef?.getViolationCount() || 0,
        capture: getCaptureHealth()
      });
      return;
    }
    if (route === "/api/capture" && req.method === "GET") {
      json(res, 200, getCaptureHealth());
      return;
    }
    if (route === "/api/config" && req.method === "GET") {
      json(res, 200, configLoaderRef?.getConfig() || {});
      return;
    }
    if (route === "/api/scope" && req.method === "GET") {
      json(res, 200, {
        configured: scopeMonitorRef ? true : false,
        targets: configLoaderRef?.getTargets() || [],
        violations: scopeMonitorRef?.getViolations() || [],
        violationCount: scopeMonitorRef?.getViolationCount() || 0
      });
      return;
    }
    if (route === "/api/quickmarks" && req.method === "GET") {
      json(res, 200, { quickmarks: listQuickMarks() });
      return;
    }
    if (route === "/api/quickmarks" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const mark = createQuickMark({
        title: body.title || "Untitled",
        url: body.url,
        note: body.note || "",
        context: body.context || {}
      });
      json(res, 201, mark);
      return;
    }
    if (route === "/api/recording" && req.method === "GET") {
      json(res, 200, { recording: !eventBus.paused });
      return;
    }
    if (route === "/api/recording" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      if (body.action === "pause") eventBus.pause();
      else if (body.action === "resume") eventBus.resume();
      else if (body.action === "toggle") {
        if (eventBus.paused) eventBus.resume();
        else eventBus.pause();
      }
      json(res, 200, { recording: !eventBus.paused });
      return;
    }
    if (route === "/api/operators" && req.method === "GET") {
      json(res, 200, { operators: listOperators().map(publicOperator) });
      return;
    }
    if (route === "/api/chain" && req.method === "GET") {
      const last = listAnchors(1)[0] ?? null;
      json(res, 200, { length: getChainLength(), lastAnchor: last });
      return;
    }
    if (route === "/api/anchors" && req.method === "GET") {
      const limit = parseInt(url2.searchParams.get("limit") || "50");
      json(res, 200, { anchors: listAnchors(limit) });
      return;
    }
    if (route === "/api/anchors" && req.method === "POST") {
      const anchor = await anchorNow();
      json(res, anchor ? 201 : 400, { anchor });
      return;
    }
    if (route === "/api/export/bundle" && req.method === "POST") {
      try {
        const bundle = exportBundle(engagementId$1);
        json(res, 201, { outDir: bundle.outDir, manifest: bundle.manifest });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }
    if (route === "/api/deconfliction" && req.method === "GET") {
      const cfg = getDeconflictionConfig();
      json(res, 200, { ...cfg, secret: cfg.secret ? "***" : "" });
      return;
    }
    if (route === "/api/deconfliction/test" && req.method === "POST") {
      const result = await testWebhook(getDeconflictionConfig());
      json(res, 200, result);
      return;
    }
    if (route === "/api/clock" && req.method === "GET") {
      json(res, 200, {
        ntpOffsetMs: getNtpOffsetMs(),
        lastQueryAt: getLastNtpQuery(),
        hostWallMs: Date.now()
      });
      return;
    }
    if (route === "/api/anchors/verify" && req.method === "GET") {
      const full = url2.searchParams.get("full") === "1";
      json(res, 200, full ? verifyChainFull() : verifyLatestAnchor());
      return;
    }
    if (route === "/api/anchors/upgrade-all" && req.method === "POST") {
      const result = await upgradeAllPending();
      json(res, 200, result);
      return;
    }
    const upgradeMatch = route.match(/^\/api\/anchors\/([^/]+)\/upgrade$/);
    if (upgradeMatch && req.method === "POST") {
      const result = await upgradeAnchor(decodeURIComponent(upgradeMatch[1]));
      json(res, result ? 200 : 404, { anchor: result });
      return;
    }
    const otsMatch = route.match(/^\/api\/anchors\/([^/]+)\/ots$/);
    if (otsMatch && req.method === "GET") {
      const anchor = getAnchorById(decodeURIComponent(otsMatch[1]));
      if (!anchor) {
        json(res, 404, { error: "Anchor not found" });
        return;
      }
      const calendarFilter = url2.searchParams.get("calendar");
      const receipt = anchor.calendarReceipts.find(
        (r) => r.ok && r.receiptB64 && (!calendarFilter || r.calendar === calendarFilter)
      );
      if (!receipt || !receipt.receiptB64) {
        json(res, 404, { error: "No successful calendar receipt available for this anchor" });
        return;
      }
      const bundle = buildOtsBundle(anchor.headHash, receipt.receiptB64);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="redlog-anchor-${anchor.id}.ots"`,
        "Content-Length": String(bundle.length),
        "X-Redlog-Head-Hash": anchor.headHash,
        "X-Redlog-Calendar": receipt.calendar
      });
      res.end(bundle);
      return;
    }
    if (route === "/api/operators" && req.method === "POST") {
      if (!operator.isPrimary) {
        json(res, 403, { error: "Only the primary operator can create operators" });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const name = (body.name || "").toString().trim();
      if (!name) {
        json(res, 400, { error: "name is required" });
        return;
      }
      const id = (body.id || "").toString().trim() || slugifyOperatorId(name);
      const token = generateToken();
      try {
        const op = createOperator({ id, name, token, isPrimary: false });
        json(res, 201, { operator: publicOperator(op), token });
      } catch (e) {
        json(res, 400, { error: e.message });
      }
      return;
    }
    const opMatch = route.match(/^\/api\/operators\/([^/]+)(?:\/(rotate|revoke))?$/);
    if (opMatch) {
      const targetId = decodeURIComponent(opMatch[1]);
      const action = opMatch[2];
      if (action === "rotate" && req.method === "POST") {
        if (!operator.isPrimary && operator.id !== targetId) {
          json(res, 403, { error: "Cannot rotate another operator token" });
          return;
        }
        const token = generateToken();
        const ok = updateOperatorToken(targetId, token);
        if (!ok) {
          json(res, 404, { error: "Operator not found" });
          return;
        }
        if (targetId === primaryOperatorId) {
          fs.writeFileSync(TOKEN_PATH, token, { mode: 384 });
          primaryToken = token;
        }
        json(res, 200, { token });
        return;
      }
      if (action === "revoke" && req.method === "POST") {
        if (!operator.isPrimary) {
          json(res, 403, { error: "Primary only" });
          return;
        }
        const ok = revokeOperator(targetId);
        json(res, ok ? 200 : 400, { revoked: ok });
        return;
      }
      if (!action && req.method === "PATCH") {
        if (!operator.isPrimary) {
          json(res, 403, { error: "Primary only" });
          return;
        }
        const body = JSON.parse(await readBody(req));
        const name = (body.name || "").toString().trim();
        if (!name) {
          json(res, 400, { error: "name is required" });
          return;
        }
        const ok = renameOperator(targetId, name);
        json(res, ok ? 200 : 404, { renamed: ok });
        return;
      }
      if (!action && req.method === "DELETE") {
        if (!operator.isPrimary) {
          json(res, 403, { error: "Primary only" });
          return;
        }
        const ok = deleteOperator(targetId);
        json(res, ok ? 200 : 400, { deleted: ok });
        return;
      }
    }
    json(res, 404, { error: `Unknown route: ${req.method} ${route}` });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}
function startApiServer(port = 6660) {
  return new Promise((resolve, reject) => {
    const token = writePrimaryToken();
    ensurePrimaryOperator(primaryOperatorId, primaryOperatorName, token);
    server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        json(res, 500, { error: err.message });
      });
    });
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      listeningPort = actualPort;
      writePort(actualPort);
      resolve(actualPort);
    });
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1");
      } else {
        reject(err);
      }
    });
  });
}
function stopApiServer() {
  server?.close();
  server = null;
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {
  }
  try {
    fs.unlinkSync(PORT_PATH);
  } catch {
  }
}
function getApiToken() {
  return primaryToken;
}
function getApiPort() {
  return listeningPort;
}
function finaliseSession(session, exitCode) {
  if (session.finalised) return;
  session.finalised = true;
  if (session.castStream) {
    try {
      session.castStream.end();
    } catch {
    }
    session.castStream = null;
  }
  let castSha256 = null;
  if (session.castPath) {
    try {
      castSha256 = crypto.createHash("sha256").update(fs.readFileSync(session.castPath)).digest("hex");
    } catch {
      castSha256 = null;
    }
  }
  try {
    const event = insertEvent("shell", {
      subtype: "session_end",
      source: "builtin-terminal",
      terminalId: session.id,
      exitCode,
      pid: session.pty.pid,
      castPath: session.castPath,
      castSha256,
      castBytes: session.castBytes,
      castTruncated: session.castTruncated,
      durationMs: Date.now() - session.castStart
    }, { engagementId, operatorId: operatorId$1 });
    if (event) eventBus.publish(event);
  } catch {
  }
}
function resolveShellHook(shell) {
  const candidates = [
    path.join(__dirname, "../../../hooks"),
    path.join(__dirname, "../../hooks")
  ];
  const dir = candidates.find((d) => fs.existsSync(d));
  if (!dir) return null;
  const file = /powershell|pwsh/i.test(shell) ? "shell-hook.ps1" : "shell-preexec-hook.sh";
  const p = path.join(dir, file);
  return fs.existsSync(p) ? p : null;
}
const sessions = /* @__PURE__ */ new Map();
let mainWindow$1 = null;
let engagementId = "";
let operatorId$1 = "";
let maxCastBytes = 50 * 1024 * 1024;
function setTerminalWindow(win) {
  mainWindow$1 = win;
}
function sendToWindow(channel, payload) {
  if (!mainWindow$1 || mainWindow$1.isDestroyed()) return;
  try {
    mainWindow$1.webContents.send(channel, payload);
  } catch {
  }
}
function configureTerminal(opts) {
  engagementId = opts.engagementId;
  operatorId$1 = opts.operatorId;
  if (typeof opts.maxCastBytes === "number" && opts.maxCastBytes > 0) maxCastBytes = opts.maxCastBytes;
}
function spawnTerminal(id, cols, rows) {
  const existing = sessions.get(id);
  if (existing) {
    if (existing.buffer) {
      const buf = existing.buffer;
      setTimeout(() => sendToWindow(`terminal:data:${id}`, buf), 0);
    }
    return { pid: existing.pty.pid };
  }
  if (!operatorId$1) {
    throw new Error("Terminal cannot spawn before configureTerminal() sets an operator identity");
  }
  const shell = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "/bin/zsh");
  const cwd = process.env.HOME || os.homedir();
  const term = pty__namespace.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      REDLOG_TERMINAL: "1"
    }
  });
  let castPath = null;
  let castStream = null;
  const castStart = Date.now();
  try {
    const dir = path.join(getProjectDir$1(), "casts");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date(castStart).toISOString().replace(/[:.]/g, "-");
    castPath = path.join(dir, `${ts}_${id}.cast`);
    castStream = fs.createWriteStream(castPath);
    const header = {
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(castStart / 1e3),
      env: { SHELL: shell, TERM: "xterm-256color" },
      title: `redlog terminal ${id}`
    };
    castStream.write(JSON.stringify(header) + "\n");
  } catch {
    castPath = null;
    castStream = null;
  }
  const session = {
    id,
    pty: term,
    buffer: "",
    lastActivity: Date.now(),
    castPath,
    castStream,
    castStart,
    castBytes: 0,
    castTruncated: false,
    finalised: false
  };
  term.onData((data) => {
    session.lastActivity = Date.now();
    session.buffer += data;
    if (session.buffer.length > 8192) {
      session.buffer = session.buffer.slice(-4096);
    }
    if (session.castStream && !session.castTruncated) {
      const encoded = JSON.stringify([(session.lastActivity - session.castStart) / 1e3, "o", data]) + "\n";
      const chunkBytes = Buffer.byteLength(encoded);
      if (session.castBytes + chunkBytes > maxCastBytes) {
        try {
          session.castStream.write(JSON.stringify([(session.lastActivity - session.castStart) / 1e3, "o", `\r
[redlog: cast truncated at ${maxCastBytes} bytes]\r
`]) + "\n");
          session.castStream.end();
        } catch {
        }
        session.castStream = null;
        session.castTruncated = true;
      } else {
        try {
          session.castStream.write(encoded);
          session.castBytes += chunkBytes;
        } catch {
        }
      }
    }
    sendToWindow(`terminal:data:${id}`, data);
  });
  term.onExit(({ exitCode }) => {
    finaliseSession(session, exitCode);
    sessions.delete(id);
    sendToWindow(`terminal:exit:${id}`, exitCode);
  });
  sessions.set(id, session);
  const event = insertEvent("shell", {
    subtype: "session_start",
    source: "builtin-terminal",
    terminalId: id,
    shell,
    pid: term.pid,
    castPath
  }, { engagementId, operatorId: operatorId$1 });
  if (event) eventBus.publish(event);
  const hookPath = resolveShellHook(shell);
  if (hookPath) {
    const isPowerShell = /powershell|pwsh/i.test(shell);
    const sourceCmd = isPowerShell ? `. "${hookPath}"\r` : `source "${hookPath.replace(/\\/g, "/")}"\r`;
    setTimeout(() => {
      if (!session.finalised) term.write(sourceCmd);
    }, 600);
  }
  return { pid: term.pid };
}
function writeTerminal(id, data) {
  sessions.get(id)?.pty.write(data);
}
function resizeTerminal(id, cols, rows) {
  try {
    sessions.get(id)?.pty.resize(cols, rows);
  } catch {
  }
}
function killTerminal(id) {
  const session = sessions.get(id);
  if (!session) return;
  finaliseSession(session, 0);
  try {
    session.pty.kill();
  } catch {
  }
  sessions.delete(id);
}
function listTerminals() {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    pid: s.pty.pid,
    lastActivity: s.lastActivity
  }));
}
function killAllTerminals() {
  for (const session of sessions.values()) {
    finaliseSession(session, 0);
    try {
      session.pty.kill();
    } catch {
    }
  }
  sessions.clear();
}
const PLUGIN_API_VERSION = 1;
const ALL_CAPABILITIES = [
  "read:events",
  "write:events",
  "read:findings",
  "read:config",
  "net:outbound"
];
const PRIVILEGED_KEYS = ["mcpTools", "exporters", "monitors"];
function tierOf(manifest) {
  const c = manifest.contributes ?? {};
  return PRIVILEGED_KEYS.some((k) => typeof c[k] === "string" && c[k].length > 0) ? "privileged" : "declarative";
}
function codeFilesOf(manifest) {
  const c = manifest.contributes ?? {};
  return PRIVILEGED_KEYS.map((k) => c[k]).filter((v) => typeof v === "string" && v.length > 0);
}
const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+/;
function validateManifest(raw, dir) {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "manifest is not an object" };
  const m = raw;
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    return { ok: false, error: "invalid id (expect lowercase kebab, 2-64 chars)" };
  }
  if (typeof m.name !== "string" || !m.name.trim()) return { ok: false, error: "missing name" };
  if (typeof m.version !== "string" || !SEMVER_RE.test(m.version)) return { ok: false, error: "invalid version (expect semver)" };
  if (typeof m.redlogApi !== "number") return { ok: false, error: "missing redlogApi" };
  if (m.redlogApi > PLUGIN_API_VERSION) {
    return { ok: false, error: `plugin targets API v${m.redlogApi}, this RedLog supports v${PLUGIN_API_VERSION}` };
  }
  if (typeof m.contributes !== "object" || m.contributes === null) {
    return { ok: false, error: "missing contributes block" };
  }
  const contributes = m.contributes;
  let capabilities;
  if (m.capabilities !== void 0) {
    if (!Array.isArray(m.capabilities)) return { ok: false, error: "capabilities must be an array" };
    for (const cap of m.capabilities) {
      if (!ALL_CAPABILITIES.includes(cap)) return { ok: false, error: `unknown capability: ${cap}` };
    }
    capabilities = m.capabilities;
  }
  for (const rel of collectFileRefs(contributes)) {
    if (rel.includes("..") || rel.startsWith("/")) return { ok: false, error: `unsafe path escapes plugin dir: ${rel}` };
    if (!fs.existsSync(path.join(dir, rel))) return { ok: false, error: `referenced file not found: ${rel}` };
  }
  const manifest = {
    id: m.id,
    name: m.name,
    version: m.version,
    description: typeof m.description === "string" ? m.description : void 0,
    author: typeof m.author === "string" ? m.author : void 0,
    homepage: typeof m.homepage === "string" ? m.homepage : void 0,
    redlogApi: m.redlogApi,
    contributes,
    capabilities,
    signature: typeof m.signature === "string" ? m.signature : void 0,
    publisher: typeof m.publisher === "string" ? m.publisher : void 0
  };
  return { ok: true, manifest };
}
function collectFileRefs(c) {
  const refs = [];
  for (const cap of c.capture ?? []) if (cap.hookFile) refs.push(cap.hookFile);
  for (const k of PRIVILEGED_KEYS) {
    const v = c[k];
    if (typeof v === "string" && v) refs.push(v);
  }
  return refs;
}
function computeContentHash(manifest, dir) {
  const h = crypto.createHash("sha256");
  h.update("manifest\0");
  h.update(JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    redlogApi: manifest.redlogApi,
    contributes: manifest.contributes,
    capabilities: manifest.capabilities ?? []
  }));
  for (const rel of codeFilesOf(manifest).sort()) {
    const p = path.join(dir, rel);
    h.update(`\0file\0${rel}\0`);
    try {
      h.update(fs.readFileSync(p));
    } catch {
      h.update("MISSING");
    }
  }
  return h.digest("hex");
}
function trustPath() {
  return path.join(os.homedir(), ".redlog", "plugins", "trust.json");
}
function read$1() {
  const p = trustPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function write$1(store) {
  const p = trustPath();
  fs.mkdirSync(path.join(os.homedir(), ".redlog", "plugins"), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
}
function isTrusted(pluginId, contentHash, requested) {
  const g = read$1()[pluginId];
  if (!g) return false;
  if (g.contentHash !== contentHash) return false;
  return requested.every((c) => g.capabilities.includes(c));
}
function grant(pluginId, contentHash, capabilities, grantedBy) {
  const store = read$1();
  store[pluginId] = { contentHash, capabilities, grantedAt: nowMs(), grantedBy };
  write$1(store);
}
function revoke(pluginId) {
  const store = read$1();
  if (store[pluginId]) {
    delete store[pluginId];
    write$1(store);
  }
}
function nowMs() {
  return Date.now();
}
function statePath() {
  return path.join(os.homedir(), ".redlog", "plugins", "state.json");
}
function read() {
  const p = statePath();
  if (!fs.existsSync(p)) return { disabled: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    return { disabled: Array.isArray(parsed?.disabled) ? parsed.disabled : [] };
  } catch {
    return { disabled: [] };
  }
}
function write(state) {
  fs.mkdirSync(path.join(os.homedir(), ".redlog", "plugins"), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}
function isDisabled(pluginId) {
  return read().disabled.includes(pluginId);
}
function setDisabled(pluginId, disabled) {
  const state = read();
  const has = state.disabled.includes(pluginId);
  if (disabled && !has) state.disabled.push(pluginId);
  else if (!disabled && has) state.disabled = state.disabled.filter((id) => id !== pluginId);
  else return;
  write(state);
}
function bundledRoot() {
  const packaged = path.join(process.resourcesPath ?? "", "plugins");
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  const devA = path.join(__dirname, "../../../plugins");
  const devB = path.join(__dirname, "../../plugins");
  return fs.existsSync(devA) ? devA : devB;
}
function userRoot() {
  return path.join(os.homedir(), ".redlog", "plugins");
}
function listPluginDirs(root) {
  if (!root || !fs.existsSync(root)) return [];
  const out = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (fs.statSync(dir).isDirectory() && fs.existsSync(path.join(dir, "plugin.json"))) out.push(dir);
    } catch {
    }
  }
  return out;
}
function statusFor(p) {
  if (isDisabled(p.manifest.id)) return "disabled";
  if (p.tier === "declarative") return "active";
  const requested = p.manifest.capabilities ?? [];
  if (isTrusted(p.manifest.id, p.contentHash, requested)) return "active";
  return "needs-consent";
}
function loadOne(dir, source) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, "plugin.json"), "utf-8"));
  } catch (e) {
    return errorPlugin(dir, source, `plugin.json is not valid JSON: ${e.message}`);
  }
  const parsed = validateManifest(raw, dir);
  if (!parsed.ok || !parsed.manifest) return errorPlugin(dir, source, parsed.error ?? "invalid manifest");
  const manifest = parsed.manifest;
  const tier = tierOf(manifest);
  const contentHash = computeContentHash(manifest, dir);
  const base = { manifest, dir, source, tier, contentHash };
  return { ...base, status: statusFor(base) };
}
function errorPlugin(dir, source, error) {
  const id = dir.split(/[\\/]/).pop() ?? "unknown";
  return {
    manifest: { id, name: id, version: "0.0.0", redlogApi: 0, contributes: {} },
    dir,
    source,
    tier: "declarative",
    status: "error",
    contentHash: "",
    error
  };
}
function loadPlugins() {
  const byId = /* @__PURE__ */ new Map();
  for (const dir of listPluginDirs(bundledRoot())) {
    const p = loadOne(dir, "bundled");
    byId.set(p.manifest.id, p);
  }
  for (const dir of listPluginDirs(userRoot())) {
    const p = loadOne(dir, "user");
    byId.set(p.manifest.id, p);
  }
  return [...byId.values()];
}
const registry = /* @__PURE__ */ new Map();
function registerEventTypes(pluginId, defs) {
  for (const d of defs) {
    if (!d.agentType || !d.label) continue;
    registry.set(`${pluginId}:${d.agentType}`, { ...d, pluginId });
  }
}
function unregisterEventTypes(pluginId) {
  for (const key of [...registry.keys()]) {
    if (registry.get(key)?.pluginId === pluginId) registry.delete(key);
  }
}
function getEventTypes() {
  return [...registry.values()];
}
function fillHookPath(steps, absHook) {
  if (!steps) return void 0;
  return steps.map((s) => ({
    label: s.label.replaceAll("{hookFile}", absHook),
    command: s.command?.replaceAll("{hookFile}", absHook)
  }));
}
function applyContributions(p) {
  const c = p.manifest.contributes ?? {};
  const id = p.manifest.id;
  if (c.lootPatterns?.length) registerLootPatterns(id, c.lootPatterns);
  if (c.redaction) registerRedactionRules(id, c.redaction);
  if (c.targetExtractors?.length) registerTargetExtractors(id, c.targetExtractors);
  if (c.eventTypes?.length) registerEventTypes(id, c.eventTypes);
  if (c.capture?.length) {
    registerCapturePlugins(
      id,
      p.dir,
      c.capture.map((cap) => ({
        id: cap.id,
        name: cap.name,
        description: cap.description,
        agentType: cap.agentType,
        requires: cap.requires,
        hookFile: cap.hookFile,
        installMethod: cap.installMethod,
        installTarget: cap.installTarget,
        shellRcFile: cap.shellRcFile,
        claudeSettingsMatcher: cap.claudeSettingsMatcher,
        manualSteps: fillHookPath(cap.manualSteps, path.join(p.dir, cap.hookFile))
      }))
    );
  }
}
function removeContributions(pluginId) {
  unregisterLootPatterns(pluginId);
  unregisterRedactionRules(pluginId);
  unregisterTargetExtractors(pluginId);
  unregisterEventTypes(pluginId);
  unregisterCapturePlugins(pluginId);
}
let current = [];
let host = null;
function setPluginHost(h) {
  host = h;
}
function applyAll(plugins) {
  for (const p of plugins) {
    if (p.status === "error" || p.status === "disabled") continue;
    applyContributions(p);
    if (p.tier === "privileged" && p.status === "active") host?.start(p);
  }
}
function removeAll(plugins) {
  for (const p of plugins) {
    removeContributions(p.manifest.id);
    if (p.tier === "privileged") host?.stop(p.manifest.id);
  }
}
function initPlugins() {
  removeAll(current);
  current = loadPlugins();
  applyAll(current);
  return summarise(current);
}
function reloadPlugins() {
  return initPlugins();
}
function listPlugins() {
  return current;
}
function listEventTypes() {
  return getEventTypes();
}
function setPluginEnabled(pluginId, enabled) {
  setDisabled(pluginId, !enabled);
  return reloadPlugins();
}
function grantPluginTrust(pluginId, grantedBy) {
  const p = current.find((x) => x.manifest.id === pluginId);
  if (!p) return { ok: false, error: "plugin not found" };
  if (p.tier !== "privileged") return { ok: false, error: "plugin requests no privileged capabilities" };
  if (p.status === "error") return { ok: false, error: p.error ?? "plugin failed to load" };
  grant(pluginId, p.contentHash, p.manifest.capabilities ?? [], grantedBy);
  reloadPlugins();
  return { ok: true };
}
function revokePluginTrust(pluginId) {
  revoke(pluginId);
  return reloadPlugins();
}
function summarise(plugins) {
  return {
    total: plugins.length,
    active: plugins.filter((p) => p.status === "active").length,
    needsConsent: plugins.filter((p) => p.status === "needs-consent" || p.status === "hash-changed").length,
    errors: plugins.filter((p) => p.status === "error").length
  };
}
function runnerPath() {
  const packaged = path.join(process.resourcesPath ?? "", "plugin-runner.js");
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged;
  const devA = path.join(__dirname, "../../../resources/plugin-runner.js");
  const devB = path.join(__dirname, "../../resources/plugin-runner.js");
  return fs.existsSync(devA) ? devA : devB;
}
function createPluginHost(services) {
  const running = /* @__PURE__ */ new Map();
  const serveCap = async (pluginId, granted, method, args) => {
    if (!methodAllowed(method, granted)) throw new Error(`capability denied: ${method}`);
    switch (method) {
      case "events.query":
        return services.queryEvents(args);
      case "events.search":
        return services.searchEvents(args);
      case "events.append":
        return services.appendEvent(pluginId, args);
      case "findings.list":
        return services.listFindings(args);
      case "config.get":
        return services.getConfig();
      case "net.fetch":
        return services.fetch(args);
      default:
        throw new Error(`unknown method: ${method}`);
    }
  };
  const start = (p) => {
    const modRel = p.manifest.contributes.mcpTools;
    if (!modRel) return;
    if (running.has(p.manifest.id)) stop(p.manifest.id);
    const granted = p.manifest.capabilities ?? [];
    let proc;
    try {
      proc = electron.utilityProcess.fork(runnerPath(), [], {
        serviceName: `redlog-plugin-${p.manifest.id}`,
        stdio: "ignore"
      });
    } catch (e) {
      console.error(`[plugins] failed to fork ${p.manifest.id}:`, e);
      return;
    }
    const state = { proc, pending: /* @__PURE__ */ new Map(), nextId: 1 };
    running.set(p.manifest.id, state);
    const dispatch = (name, args) => new Promise((resolve, reject) => {
      const id = state.nextId++;
      state.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        if (state.pending.delete(id)) reject(new Error("plugin tool timed out"));
      }, 3e4);
      const orig = state.pending.get(id);
      state.pending.set(id, { resolve: (v) => {
        clearTimeout(timer);
        orig.resolve(v);
      }, reject: (e) => {
        clearTimeout(timer);
        orig.reject(e);
      } });
      proc.postMessage({ kind: "call", id, name, args });
    });
    proc.on("message", async (msg) => {
      const kind = msg?.kind;
      if (kind === "ready") {
        const tools = msg.tools ?? [];
        registerPluginTools(p.manifest.id, tools, dispatch);
        console.log(`[plugins] ${p.manifest.id}: ${tools.length} tool(s) live`);
      } else if (kind === "init-error") {
        console.error(`[plugins] ${p.manifest.id} init failed:`, msg.error);
      } else if (kind === "log") {
        console.log(`[plugin:${p.manifest.id}]`, msg.message);
      } else if (kind === "call-result") {
        const waiter = state.pending.get(msg.id);
        if (waiter) {
          state.pending.delete(msg.id);
          msg.error ? waiter.reject(new Error(String(msg.error))) : waiter.resolve(msg.result);
        }
      } else if (kind === "cap") {
        try {
          const result = await serveCap(p.manifest.id, granted, String(msg.method), msg.args ?? {});
          proc.postMessage({ kind: "cap-result", id: msg.id, result });
        } catch (e) {
          proc.postMessage({ kind: "cap-result", id: msg.id, error: e.message });
        }
      }
    });
    proc.on("exit", () => {
      unregisterPluginTools(p.manifest.id);
      running.delete(p.manifest.id);
    });
    proc.postMessage({ kind: "init", modulePath: path.join(p.dir, modRel), dir: p.dir, capabilities: granted });
  };
  const stop = (pluginId) => {
    const state = running.get(pluginId);
    if (!state) return;
    unregisterPluginTools(pluginId);
    try {
      state.proc.kill();
    } catch {
    }
    running.delete(pluginId);
  };
  return { start, stop };
}
const DEFAULT_BROWSER = {
  binary: "",
  proxy: "http://127.0.0.1:8080",
  cdpPort: 9222,
  isolateProfile: true,
  ignoreCertErrors: true,
  startUrl: "",
  extraArgs: []
};
const MAC_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
];
const WIN_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe"
];
const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/brave-browser",
  "/usr/bin/microsoft-edge"
];
function detectBrowser() {
  const candidates = os.platform() === "darwin" ? MAC_CANDIDATES : os.platform() === "win32" ? WIN_CANDIDATES : LINUX_CANDIDATES;
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}
function buildArgs(cfg, profileDir) {
  const args = [];
  if (cfg.proxy) {
    args.push(`--proxy-server=${cfg.proxy}`);
    args.push("--proxy-bypass-list=<-loopback>");
  }
  if (cfg.cdpPort > 0) args.push(`--remote-debugging-port=${cfg.cdpPort}`);
  if (cfg.isolateProfile) {
    args.push(`--user-data-dir=${profileDir}`);
    args.push("--no-first-run", "--no-default-browser-check");
  }
  if (cfg.ignoreCertErrors) args.push("--ignore-certificate-errors");
  args.push(...cfg.extraArgs.filter(Boolean));
  if (cfg.startUrl) args.push(cfg.startUrl);
  return args;
}
let child = null;
function isBrowserRunning() {
  return !!child && child.exitCode === null && !child.killed;
}
function launchBrowser(cfg, projectDir) {
  if (isBrowserRunning()) {
    return { ok: false, error: "A RedLog browser is already running", pid: child?.pid };
  }
  const binary = cfg.binary || detectBrowser();
  if (!binary) {
    return { ok: false, error: "No Chromium-based browser found. Set the binary path in Settings ▸ Data." };
  }
  if (!fs.existsSync(binary)) {
    return { ok: false, error: `Browser binary not found: ${binary}` };
  }
  const profileDir = path.join(projectDir, "browser-profile");
  if (cfg.isolateProfile) fs.mkdirSync(profileDir, { recursive: true });
  const args = buildArgs(cfg, profileDir);
  try {
    child = child_process.spawn(binary, args, { detached: true, stdio: "ignore" });
    child.unref();
    child.on("exit", () => {
      child = null;
    });
    return { ok: true, pid: child.pid, binary, args, profileDir };
  } catch (e) {
    child = null;
    return { ok: false, error: e.message };
  }
}
function stopBrowser() {
  if (!isBrowserRunning()) return false;
  try {
    child.kill();
  } catch {
  }
  child = null;
  return true;
}
const SYS_PATH = ["/sbin", "/usr/sbin", "/usr/bin", "/bin"].join(":");
function run(cmd, timeout = 2500) {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: `${SYS_PATH}:${process.env.PATH ?? ""}` };
    child_process.exec(cmd, { timeout, windowsHide: true, env }, (err, stdout) => resolve(err ? "" : stdout));
  });
}
async function detectMac() {
  const routeOut = await run("route -n get default 2>/dev/null");
  const defaultDev = routeOut.match(/interface:\s*(\S+)/)?.[1] ?? "";
  const ports = await run("networksetup -listallhardwareports");
  const wifiDev = ports.match(/Hardware Port:\s*Wi-Fi[\s\S]*?Device:\s*(\S+)/)?.[1] ?? "";
  if (defaultDev && wifiDev && defaultDev === wifiDev) {
    const usable = (s) => {
      const v = s?.trim() ?? "";
      if (!v || /^<.*>$/.test(v) || /redacted|not associated/i.test(v)) return "";
      return v;
    };
    const summary = await run(`ipconfig getsummary ${wifiDev}`);
    const ssid = usable(summary.match(/^\s*SSID\s*:\s*(.+)$/im)?.[1]);
    if (ssid) return { type: "wifi", name: ssid };
    const ssidOut = await run(`networksetup -getairportnetwork ${wifiDev}`);
    const ssid2 = usable(ssidOut.match(/Current Wi-Fi Network:\s*(.+)/)?.[1]);
    if (ssid2) return { type: "wifi", name: ssid2 };
    return { type: "wifi", name: "" };
  }
  if (defaultDev) return { type: "wired", name: "" };
  return { type: "unknown", name: "" };
}
async function detectWindows() {
  const wlan = await run("netsh wlan show interfaces");
  if (/State\s*:\s*connected/i.test(wlan)) {
    const ssid = wlan.match(/^\s*SSID\s*:\s*(.+)$/im)?.[1]?.trim();
    if (ssid) return { type: "wifi", name: ssid };
  }
  const route = await run('powershell -NoProfile -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -First 1).InterfaceAlias"');
  if (route.trim()) return { type: "wired", name: "" };
  return { type: "unknown", name: "" };
}
async function detectLinux() {
  const ssid = (await run("iwgetid -r")).trim();
  if (ssid) return { type: "wifi", name: ssid };
  const nm = (await run("nmcli -t -f active,ssid dev wifi 2>/dev/null")).split("\n").find((l) => l.startsWith("yes:"));
  if (nm) return { type: "wifi", name: nm.slice(4).trim() };
  const route = (await run("ip route show default 2>/dev/null")).trim();
  if (route) return { type: "wired", name: "" };
  return { type: "unknown", name: "" };
}
async function detectLink() {
  try {
    if (process.platform === "darwin") return await detectMac();
    if (process.platform === "win32") return await detectWindows();
    return await detectLinux();
  } catch {
    return { type: "unknown", name: "" };
  }
}
const OWNER = "guan4tou2";
const REPO = "REDLOG";
const RELEASES_PAGE = `https://github.com/${OWNER}/${REPO}/releases/latest`;
function parseVer(v) {
  return v.replace(/^v/, "").split(/[.\-+]/).map((n) => parseInt(n, 10) || 0);
}
function isNewer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
async function fetchLatest() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8e3);
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { "User-Agent": "RedLog", Accept: "application/vnd.github+json" },
      signal: controller.signal
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.tag_name) return null;
    return { version: data.tag_name.replace(/^v/, ""), url: data.html_url || RELEASES_PAGE };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
async function checkForUpdates(opts = {}) {
  const manual = opts.manual ?? false;
  if (!electron.app.isPackaged && !manual) return;
  const latest = await fetchLatest();
  if (!latest) {
    if (manual) {
      await electron.dialog.showMessageBox({
        type: "warning",
        buttons: ["好"],
        title: "檢查更新",
        message: "無法連線檢查更新,請稍後再試。"
      });
    }
    return;
  }
  if (isNewer(latest.version, electron.app.getVersion())) {
    const detail = process.platform === "darwin" ? "macOS 版請前往下載頁手動更新(自動安裝需程式簽章)。" : "前往下載頁取得最新安裝檔。";
    const r = await electron.dialog.showMessageBox({
      type: "info",
      buttons: ["前往下載", "稍後"],
      defaultId: 0,
      cancelId: 1,
      title: "有新版本",
      message: `RedLog ${latest.version} 可用(目前 ${electron.app.getVersion()})`,
      detail
    });
    if (r.response === 0) await electron.shell.openExternal(latest.url);
  } else if (manual) {
    await electron.dialog.showMessageBox({
      type: "info",
      buttons: ["好"],
      title: "已是最新版",
      message: `RedLog ${electron.app.getVersion()} 已是最新版本。`
    });
  }
}
let mainWindow = null;
let overlayWindow = null;
let tray = null;
let activeProject = null;
let forceQuit = false;
let overlayMouseInside = false;
let overlayTrackingInterval = null;
function startOverlayMouseTracking() {
  if (overlayTrackingInterval) clearInterval(overlayTrackingInterval);
  overlayTrackingInterval = setInterval(() => {
    if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return;
    const point = electron.screen.getCursorScreenPoint();
    const bounds = overlayWindow.getBounds();
    const inside = point.x >= bounds.x && point.x <= bounds.x + bounds.width && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
    if (inside && !overlayMouseInside) {
      overlayMouseInside = true;
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.webContents.send("overlay:interactive", true);
    } else if (!inside && overlayMouseInside) {
      overlayMouseInside = false;
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.webContents.send("overlay:interactive", false);
    }
  }, 50);
}
function stopOverlayMouseTracking() {
  if (overlayTrackingInterval) {
    clearInterval(overlayTrackingInterval);
    overlayTrackingInterval = null;
  }
}
function send(win, channel, payload) {
  if (!win || win.isDestroyed()) return;
  try {
    win.webContents.send(channel, payload);
  } catch {
  }
}
function toggleRecording() {
  if (eventBus.paused) eventBus.resume();
  else eventBus.pause();
  const recording = !eventBus.paused;
  send(mainWindow, "recording:changed", recording);
  send(overlayWindow, "recording:changed", recording);
  return recording;
}
function triggerQuickMark() {
  send(mainWindow, "shortcut:marker");
  mainWindow?.show();
  mainWindow?.focus();
}
const WINDOW_STATE_PATH = path.join(os.homedir(), ".redlog", "window-state.json");
function loadWindowState() {
  try {
    return JSON.parse(fs.readFileSync(WINDOW_STATE_PATH, "utf-8"));
  } catch {
    return null;
  }
}
function saveWindowState(win) {
  try {
    const isMaximized = win.isMaximized();
    const bounds = isMaximized ? void 0 : win.getBounds();
    fs.mkdirSync(path.dirname(WINDOW_STATE_PATH), { recursive: true });
    fs.writeFileSync(WINDOW_STATE_PATH, JSON.stringify({ bounds, isMaximized }));
  } catch {
  }
}
let saveTimer = null;
function debouncedSaveWindowState(win) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveWindowState(win), 500);
}
const ipMonitor = new IPMonitor();
const screenshotAgent = new ScreenshotAgent();
const scopeMonitor = new ScopeMonitor();
const lootDetector = new LootDetector();
function getActivePivots() {
  try {
    const evs = queryEvents({ agentType: "pivot", limit: 40 });
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const e of evs) {
      const d = e.data ?? {};
      const via = d.via || "";
      if (!via || seen.has(via)) continue;
      seen.add(via);
      out.push({ via, tool: String(d.tool ?? "pivot"), route: d.route, ts: e.timestamp });
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  }
}
let currentLink = { type: "unknown", name: "" };
let linkTimer = null;
let keepDockIcon = true;
function applyDock() {
  if (process.platform !== "darwin") return;
  if (keepDockIcon) electron.app.dock?.show();
  else electron.app.dock?.hide();
}
function startLinkMonitor() {
  const refresh = () => {
    detectLink().then((l) => {
      currentLink = l;
    }).catch(() => {
    });
  };
  refresh();
  if (linkTimer) clearInterval(linkTimer);
  linkTimer = setInterval(refresh, 2e4);
}
function broadcastIPStatus(status) {
  const s = { ...status, link: currentLink };
  send(mainWindow, "ip:status", s);
  send(overlayWindow, "ip:status", s);
}
function startProject(project) {
  activeProject = project;
  const projectDir = getProjectDir(project);
  const config = loadConfig(projectDir);
  saveConfig(projectDir, config);
  keepDockIcon = config.overlay?.showInDock !== false;
  applyDock();
  const engagementId2 = config.engagement.id;
  const operatorId2 = config.operator.id;
  initDB(projectDir);
  ipMonitor.configure({
    whitelist: config.network.whitelist,
    blacklist: config.network.blacklist,
    checkInterval: config.network.checkInterval,
    providers: config.network.providers,
    confirmations: config.network.confirmations,
    ipMode: config.network.ipMode
  });
  screenshotAgent.configure({ engagementId: engagementId2, operatorId: operatorId2, quality: config.screenshot.quality });
  let scopeTargets = config.scope.targets;
  if (config.scope.scopeFile) {
    const loaded = loadScopeFile(config.scope.scopeFile);
    if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded];
  }
  scopeMonitor.configure({
    enforcement: config.scope.enforcement,
    targets: scopeTargets,
    excludeTargets: config.scope.excludeTargets,
    engagementId: engagementId2,
    operatorId: operatorId2
  });
  lootDetector.configure({ engagementId: engagementId2, operatorId: operatorId2 });
  configureRedaction(config.redaction);
  setPluginHost(createPluginHost({
    queryEvents: (a) => queryEvents({ limit: Math.min(Number(a.limit) || 50, 500), type: a.type, target: a.target }),
    searchEvents: (a) => searchEvents(String(a.query ?? ""), Math.min(Number(a.limit) || 20, 200)),
    appendEvent: (pluginId, a) => {
      const ev = insertEvent(String(a.agent_type ?? "agent"), { ...a.data, plugin: pluginId }, { operatorId: operatorId2, engagementId: engagementId2 });
      if (ev) eventBus.publish(ev);
      return { ok: !!ev };
    },
    listFindings: () => listQuickMarks(),
    getConfig: () => ({ engagement: config.engagement, scope: config.scope, redaction: config.redaction }),
    fetch: async (a) => {
      const r = await fetch(String(a.url), { method: String(a.method ?? "GET") });
      return { status: r.status, body: (await r.text()).slice(0, 1e4) };
    }
  }));
  try {
    const psum = initPlugins();
    if (psum.total > 0) console.log(`[plugins] ${psum.active} active, ${psum.needsConsent} need consent, ${psum.errors} errors`);
  } catch (e) {
    console.error("[plugins] init failed:", e);
  }
  configureDeconfliction(config.deconfliction);
  configureTerminal({ engagementId: engagementId2, operatorId: operatorId2, maxCastBytes: config.terminal?.maxCastBytes });
  ipMonitor.start();
  startLinkMonitor();
  configureApi({
    engagementId: engagementId2,
    operatorId: operatorId2,
    operatorName: config.operator.name,
    configLoader: {
      getConfig: () => loadConfig(projectDir),
      getTargets: () => config.scope.targets
    },
    lootDetector,
    screenshotAgent,
    ipMonitor,
    scopeMonitor
  });
  startApiServer(6660).then((port) => {
    insertEvent("system", { subtype: "api_started", port, token: getApiToken().slice(0, 8) + "..." }, { engagementId: engagementId2, operatorId: operatorId2 });
  });
  insertEvent("system", { subtype: "session_start" }, { engagementId: engagementId2, operatorId: operatorId2 });
  startAnchorLoop();
  startNtpLoop();
  if (!overlayWindow) {
    overlayWindow = createOverlayWindow();
    if (process.platform === "darwin") {
      overlayWindow.on("show", applyDock);
      applyDock();
      setTimeout(applyDock, 250);
    }
    startOverlayMouseTracking();
    if (tray) {
      tray.destroy();
      tray = createTray(mainWindow, overlayWindow, toggleRecording, triggerQuickMark);
      setTrayRecording(tray, !eventBus.paused);
    }
  }
}
function stopProject() {
  stopAnchorLoop();
  stopNtpLoop();
  stopApiServer();
  ipMonitor.stop();
  closeDB();
  activeProject = null;
}
const gotSingleInstanceLock = electron.app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  electron.app.quit();
}
electron.app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});
electron.app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  electronApp.setAppUserModelId("com.redlog");
  setAppVersion("0.6.2");
  if (process.platform === "darwin") electron.app.dock?.show();
  electron.session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "geolocation");
  });
  const savedState = loadWindowState();
  mainWindow = createMainWindow(savedState?.bounds);
  if (savedState?.isMaximized) mainWindow.maximize();
  setTerminalWindow(mainWindow);
  mainWindow.on("resize", () => {
    if (mainWindow) debouncedSaveWindowState(mainWindow);
  });
  mainWindow.on("move", () => {
    if (mainWindow) debouncedSaveWindowState(mainWindow);
  });
  mainWindow.on("close", (e) => {
    if (!forceQuit) {
      e.preventDefault();
      if (mainWindow) saveWindowState(mainWindow);
      mainWindow?.hide();
    }
  });
  tray = createTray(mainWindow, null, toggleRecording, triggerQuickMark);
  electron.ipcMain.handle("project:list", () => listProjects());
  electron.ipcMain.handle("project:create", (_e, name, initialConfig) => {
    const project = createProject(name);
    if (initialConfig) {
      const projectDir = getProjectDir(project);
      const config = loadConfig(projectDir);
      const merged = {
        ...config,
        engagement: { ...config.engagement, ...initialConfig.engagement },
        operator: { ...config.operator, ...initialConfig.operator },
        network: { ...config.network, ...initialConfig.network },
        scope: { ...config.scope, ...initialConfig.scope },
        screenshot: { ...config.screenshot, ...initialConfig.screenshot }
      };
      saveConfig(projectDir, merged);
    }
    startProject(project);
    return project;
  });
  electron.ipcMain.handle("project:open", (_e, id) => {
    const project = openProject(id);
    if (!project) return null;
    startProject(project);
    return project;
  });
  electron.ipcMain.handle("project:delete", (_e, id) => deleteProject(id));
  electron.ipcMain.handle("project:active", () => activeProject ? { id: activeProject.id, name: activeProject.name } : null);
  electron.ipcMain.handle("ip:getStatus", () => ipMonitor.status);
  electron.ipcMain.handle("config:get", () => {
    if (!activeProject) return null;
    return loadConfig(getProjectDir(activeProject));
  });
  electron.ipcMain.handle("config:save", (_e, newConfig) => {
    if (!activeProject) return false;
    const projectDir = getProjectDir(activeProject);
    saveConfig(projectDir, newConfig);
    keepDockIcon = newConfig.overlay?.showInDock !== false;
    applyDock();
    ipMonitor.configure({
      whitelist: newConfig.network.whitelist,
      blacklist: newConfig.network.blacklist,
      ipMode: newConfig.network.ipMode,
      checkInterval: newConfig.network.checkInterval,
      providers: newConfig.network.providers,
      confirmations: newConfig.network.confirmations
    });
    let targets = newConfig.scope.targets;
    if (newConfig.scope.scopeFile) {
      const loaded = loadScopeFile(newConfig.scope.scopeFile);
      if (loaded.length > 0) targets = [...targets, ...loaded];
    }
    scopeMonitor.configure({
      enforcement: newConfig.scope.enforcement,
      targets,
      excludeTargets: newConfig.scope.excludeTargets
    });
    screenshotAgent.configure({ quality: newConfig.screenshot.quality });
    if (newConfig.redaction) configureRedaction(newConfig.redaction);
    if (newConfig.deconfliction) configureDeconfliction(newConfig.deconfliction);
    send(overlayWindow, "overlay:showMark", newConfig.overlay?.showMarkButton !== false);
    return true;
  });
  electron.ipcMain.on("overlay:autosize", (_e, height) => {
    const h = Math.max(46, Math.min(560, Math.round(Number(height) || 46)));
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.setSize(440, h);
  });
  electron.ipcMain.on("overlay:setExpanded", () => {
  });
  electron.ipcMain.on("overlay:hide", () => {
    overlayWindow?.hide();
    send(mainWindow, "overlay:visibilityChanged", false);
  });
  electron.ipcMain.on("overlay:show", () => {
    overlayWindow?.show();
    send(mainWindow, "overlay:visibilityChanged", true);
  });
  electron.ipcMain.on("overlay:toggle", () => {
    if (overlayWindow?.isVisible()) {
      overlayWindow.hide();
    } else {
      overlayWindow?.show();
    }
    send(mainWindow, "overlay:visibilityChanged", overlayWindow?.isVisible() ?? false);
  });
  electron.ipcMain.handle("overlay:isVisible", () => {
    return overlayWindow?.isVisible() ?? false;
  });
  electron.ipcMain.on("overlay:mouseEnter", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = true;
      overlayWindow.setIgnoreMouseEvents(false);
      overlayWindow.webContents.send("overlay:interactive", true);
    }
  });
  electron.ipcMain.on("overlay:mouseLeave", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayMouseInside = false;
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.webContents.send("overlay:interactive", false);
    }
  });
  ipMonitor.on("status", broadcastIPStatus);
  electron.ipcMain.handle("events:query", (_e, opts) => queryEvents(opts));
  electron.ipcMain.handle("events:getCount", () => getEventCount());
  electron.ipcMain.handle("events:search", (_e, query, limit) => searchEvents(query, limit));
  eventBus.on("event", (event) => {
    send(mainWindow, "events:new", event);
    notifyDeconfliction(event);
    if (event.agentType === "pivot") {
      const p = getActivePivots();
      send(overlayWindow, "pivots:changed", p);
      send(mainWindow, "pivots:changed", p);
    }
  });
  electron.ipcMain.handle("pivots:getActive", () => getActivePivots());
  electron.ipcMain.handle("marker:create", (_e, data) => {
    if (!activeProject) return null;
    const config = loadConfig(getProjectDir(activeProject));
    const event = insertEvent("marker", {
      title: data.title,
      notes: data.notes,
      severity: data.severity ?? "info",
      category: data.category ?? "custom"
    }, { engagementId: config.engagement.id, operatorId: config.operator.id });
    if (event) eventBus.publish(event);
    return event;
  });
  electron.ipcMain.handle("screenshot:capture", () => screenshotAgent.captureNow("manual"));
  electron.ipcMain.handle("screenshot:read", (_e, filePath) => {
    try {
      const screenshotDir = path.join(getProjectDir$1(), "screenshots");
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(screenshotDir)) return null;
      const data = fs.readFileSync(resolved);
      return `data:image/jpeg;base64,${data.toString("base64")}`;
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("scope:getViolations", () => scopeMonitor.getViolations());
  electron.ipcMain.handle("scope:getViolationCount", () => scopeMonitor.getViolationCount());
  electron.ipcMain.handle("scope:isConfigured", () => scopeMonitor.isConfigured());
  electron.ipcMain.handle("chain:length", () => getChainLength());
  electron.ipcMain.handle("chain:anchors", () => activeProject ? listAnchors() : []);
  electron.ipcMain.handle("chain:anchorNow", async () => activeProject ? await anchorNow() : null);
  electron.ipcMain.handle("chain:verify", (_e, opts) => {
    if (!activeProject) return { ok: false, anchor: null, currentHead: null };
    return opts?.full ? verifyChainFull() : verifyLatestAnchor();
  });
  electron.ipcMain.handle("chain:upgrade", async (_e, id) => {
    if (!activeProject) return null;
    if (id) return await upgradeAnchor(id);
    return await upgradeAllPending();
  });
  electron.ipcMain.handle("deconfliction:get", () => getDeconflictionConfig());
  electron.ipcMain.handle("deconfliction:test", async (_e, cfg) => testWebhook(cfg));
  electron.ipcMain.handle("clock:status", () => ({
    ntpOffsetMs: getNtpOffsetMs(),
    lastQueryAt: getLastNtpQuery(),
    hostWallMs: Date.now()
  }));
  electron.ipcMain.handle("loot:getCount", () => lootDetector.getLootCount());
  electron.ipcMain.handle("quickmarks:list", () => listQuickMarks());
  electron.ipcMain.handle("quickmarks:get", (_e, id) => getQuickMark(id));
  electron.ipcMain.handle("quickmarks:create", async (_e, data) => {
    const browser = await getActiveBrowserTab();
    const context = {
      browserUrl: browser.url || void 0,
      browserTitle: browser.title || void 0,
      externalIP: ipMonitor.status.externalIP || void 0
    };
    return createQuickMark({
      title: data.title || browser.title || "Untitled",
      url: data.url || browser.url || void 0,
      note: data.note,
      context
    });
  });
  electron.ipcMain.handle("quickmarks:update", (_e, id, data) => updateQuickMark(id, data));
  electron.ipcMain.handle("quickmarks:delete", (_e, id) => deleteQuickMark(id));
  electron.ipcMain.handle("browser:detect", () => detectBrowser());
  electron.ipcMain.handle("browser:status", () => ({ running: isBrowserRunning() }));
  electron.ipcMain.handle("browser:launch", () => {
    if (!activeProject) return { ok: false, error: "No project open" };
    const projectDir = getProjectDir(activeProject);
    const cfg = loadConfig(projectDir);
    const browserCfg = { ...DEFAULT_BROWSER, ...cfg.browser ?? {} };
    const result = launchBrowser(browserCfg, projectDir);
    if (result.ok) {
      setCdpPort(browserCfg.cdpPort);
      const event = insertEvent("system", {
        subtype: "browser_launched",
        binary: result.binary,
        proxy: browserCfg.proxy || null,
        cdpPort: browserCfg.cdpPort,
        isolatedProfile: browserCfg.isolateProfile,
        pid: result.pid
      }, { engagementId: cfg.engagement.id, operatorId: cfg.operator.id });
      if (event) eventBus.publish(event);
    }
    return result;
  });
  electron.ipcMain.handle("browser:stop", () => ({ stopped: stopBrowser() }));
  electron.ipcMain.handle("cdp:getTab", () => getActiveBrowserTab());
  electron.ipcMain.handle("cdp:setPort", (_e, port) => {
    setCdpPort(port);
    return true;
  });
  electron.ipcMain.handle("data:exportBundle", () => {
    if (!activeProject) return null;
    const cfg = loadConfig(getProjectDir(activeProject));
    const bundle = exportBundle(cfg.engagement.id);
    return { outDir: bundle.outDir, manifest: bundle.manifest };
  });
  electron.ipcMain.handle("data:exportJson", () => {
    if (!activeProject) return null;
    const projectDir = getProjectDir(activeProject);
    const config = loadConfig(projectDir);
    const events2 = queryEvents({ limit: 1e5 });
    const marks = listQuickMarks();
    const data = { config, quickmarks: marks, events: events2, exportedAt: (/* @__PURE__ */ new Date()).toISOString() };
    const outDir = path.join(projectDir, "exports");
    fs.mkdirSync(outDir, { recursive: true });
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filePath = path.join(outDir, `redlog-${ts}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  });
  electron.ipcMain.handle("config:exportProfile", async () => {
    if (!activeProject) return null;
    const projectDir = getProjectDir(activeProject);
    const config = loadConfig(projectDir);
    const profile = { version: 1, ...config };
    const result = await electron.dialog.showSaveDialog(mainWindow, {
      defaultPath: `redlog-profile-${activeProject.name.replace(/[^a-z0-9]/gi, "-")}.yaml`,
      filters: [
        { name: "REDLOG Profile", extensions: ["yaml", "yml"] },
        { name: "JSON", extensions: ["json"] }
      ]
    });
    if (result.canceled || !result.filePath) return null;
    const ext = path.extname(result.filePath).toLowerCase();
    if (ext === ".json") {
      fs.writeFileSync(result.filePath, JSON.stringify(profile, null, 2));
    } else {
      fs.writeFileSync(result.filePath, `# REDLOG Profile — share with your team
${yaml.dump(profile, { lineWidth: 120 })}`);
    }
    return result.filePath;
  });
  electron.ipcMain.handle("config:importProfile", async () => {
    const result = await electron.dialog.showOpenDialog(mainWindow, {
      filters: [
        { name: "REDLOG Profile", extensions: ["yaml", "yml", "json"] }
      ],
      properties: ["openFile"]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    try {
      const raw = fs.readFileSync(result.filePaths[0], "utf-8");
      const ext = path.extname(result.filePaths[0]).toLowerCase();
      const data = ext === ".json" ? JSON.parse(raw) : yaml.load(raw);
      delete data.version;
      return data;
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("terminal:spawn", (_e, id, cols, rows) => spawnTerminal(id, cols, rows));
  electron.ipcMain.on("terminal:write", (_e, id, data) => writeTerminal(id, data));
  electron.ipcMain.on("terminal:resize", (_e, id, cols, rows) => resizeTerminal(id, cols, rows));
  electron.ipcMain.on("terminal:kill", (_e, id) => killTerminal(id));
  electron.ipcMain.handle("terminal:list", () => listTerminals());
  electron.ipcMain.handle("data:exportScopeFiltered", () => {
    if (!activeProject) return null;
    const projectDir = getProjectDir(activeProject);
    const config = loadConfig(projectDir);
    let scopeTargets = config.scope.targets;
    if (config.scope.scopeFile) {
      const loaded = loadScopeFile(config.scope.scopeFile);
      if (loaded.length > 0) scopeTargets = [...scopeTargets, ...loaded];
    }
    const events2 = queryScopeFilteredEvents(scopeTargets);
    const marks = listQuickMarks();
    const data = {
      engagement: config.engagement,
      operator: config.operator,
      scope: config.scope,
      quickmarks: marks,
      events: events2,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      filtered: true,
      scopeTargets
    };
    const outDir = path.join(projectDir, "exports");
    fs.mkdirSync(outDir, { recursive: true });
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filePath = path.join(outDir, `redlog-scope-${ts}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return filePath;
  });
  electron.ipcMain.handle("hooks:detect", () => detectHooks());
  electron.ipcMain.handle("capture:health", () => activeProject ? getCaptureHealth() : null);
  electron.ipcMain.handle("hooks:install", (_e, hookId) => {
    invalidateHooksCache();
    return installHook(hookId);
  });
  electron.ipcMain.handle("hooks:uninstall", (_e, hookId) => {
    invalidateHooksCache();
    return uninstallHook(hookId);
  });
  const pluginView = () => listPlugins().map((p) => ({
    id: p.manifest.id,
    name: p.manifest.name,
    version: p.manifest.version,
    description: p.manifest.description ?? "",
    author: p.manifest.author ?? "",
    source: p.source,
    tier: p.tier,
    status: p.status,
    capabilities: p.manifest.capabilities ?? [],
    contributes: Object.keys(p.manifest.contributes ?? {}),
    error: p.error
  }));
  electron.ipcMain.handle("plugins:list", () => pluginView());
  electron.ipcMain.handle("plugins:eventTypes", () => listEventTypes());
  electron.ipcMain.handle("plugins:reload", () => {
    invalidateHooksCache();
    reloadPlugins();
    return pluginView();
  });
  electron.ipcMain.handle("plugins:setEnabled", (_e, id, enabled) => {
    setPluginEnabled(id, enabled);
    invalidateHooksCache();
    return pluginView();
  });
  electron.ipcMain.handle("plugins:grant", (_e, id) => {
    const r = grantPluginTrust(id, operatorId);
    return { ...r, plugins: pluginView() };
  });
  electron.ipcMain.handle("plugins:revoke", (_e, id) => {
    revokePluginTrust(id);
    return pluginView();
  });
  electron.ipcMain.handle("recording:get", () => !eventBus.paused);
  electron.ipcMain.handle("recording:toggle", () => toggleRecording());
  eventBus.on("recording", (recording) => {
    send(mainWindow, "recording:changed", recording);
    send(overlayWindow, "recording:changed", recording);
    if (tray) setTrayRecording(tray, recording);
  });
  const MCP_OPERATOR_ID = "mcp-agent";
  electron.ipcMain.handle("mcp:info", () => {
    if (!activeProject) return null;
    const port = getApiPort();
    const stdioPath = electron.app.isPackaged ? path.join(process.resourcesPath, "mcp", "redlog-mcp-server.js") : path.join(__dirname, "../../mcp/redlog-mcp-server.js");
    return {
      port,
      endpoint: `http://127.0.0.1:${port}/mcp`,
      stdioPath,
      hasToken: listOperators().some((o) => o.id === MCP_OPERATOR_ID && !o.revokedAt)
    };
  });
  electron.ipcMain.handle("mcp:setupToken", () => {
    if (!activeProject) return null;
    const token = generateToken();
    const existing = listOperators().find((o) => o.id === MCP_OPERATOR_ID);
    if (existing) updateOperatorToken(MCP_OPERATOR_ID, token);
    else createOperator({ id: MCP_OPERATOR_ID, name: "MCP agent", token, isPrimary: false });
    return { token, port: getApiPort(), endpoint: `http://127.0.0.1:${getApiPort()}/mcp` };
  });
  electron.ipcMain.handle("operators:list", () => {
    if (!activeProject) return [];
    return listOperators().map((op) => ({
      id: op.id,
      name: op.name,
      isPrimary: op.isPrimary,
      createdAt: op.createdAt,
      revokedAt: op.revokedAt
    }));
  });
  electron.ipcMain.handle("operators:create", (_e, name) => {
    if (!activeProject) return null;
    const trimmed = (name || "").trim();
    if (!trimmed) return null;
    const id = slugifyOperatorId(trimmed);
    const token = generateToken();
    try {
      const op = createOperator({ id, name: trimmed, token, isPrimary: false });
      return { operator: { id: op.id, name: op.name, isPrimary: false, createdAt: op.createdAt, revokedAt: null }, token };
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("operators:rotate", (_e, id) => {
    if (!activeProject) return null;
    const token = generateToken();
    const ok = updateOperatorToken(id, token);
    if (!ok) return null;
    const primary = listOperators().find((o) => o.id === id && o.isPrimary);
    if (primary) {
      const tokenPath = path.join(os.homedir(), ".redlog", "api-token");
      try {
        fs.writeFileSync(tokenPath, token, { mode: 384 });
      } catch {
      }
    }
    return { token };
  });
  electron.ipcMain.handle("operators:rename", (_e, id, name) => {
    if (!activeProject) return false;
    const trimmed = (name || "").trim();
    if (!trimmed) return false;
    return renameOperator(id, trimmed);
  });
  electron.ipcMain.handle("operators:revoke", (_e, id) => {
    if (!activeProject) return false;
    return revokeOperator(id);
  });
  electron.ipcMain.handle("operators:delete", (_e, id) => {
    if (!activeProject) return false;
    return deleteOperator(id);
  });
  electron.globalShortcut.register("CommandOrControl+Shift+M", triggerQuickMark);
  electron.ipcMain.on("overlay:quickMark", triggerQuickMark);
  electron.ipcMain.handle("app:checkForUpdates", () => checkForUpdates({ manual: true }));
  setTimeout(() => {
    checkForUpdates().catch(() => {
    });
  }, 5e3);
  electron.app.on("activate", () => {
    mainWindow?.show();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
electron.app.on("before-quit", () => {
  forceQuit = true;
});
electron.app.on("will-quit", () => {
  stopBrowser();
  electron.globalShortcut.unregisterAll();
  stopOverlayMouseTracking();
  killAllTerminals();
  stopProject();
  tray?.destroy();
});

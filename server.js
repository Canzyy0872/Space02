/**
 * Minimap Relay Server — v3 (Key Auth Edition)
 *
 * Endpoint publik:
 *   POST /push/:slot          ← C++ mod kirim data hero
 *   GET  /get/:slot           ← Android ambil snapshot awal
 *   WS   /ws/:slot            ← Android subscribe real-time
 *   GET  /status              ← health check
 *   POST /auth/login          ← Java login pakai key → dapat slot
 *
 * Endpoint admin (Basic Auth dari ENV):
 *   GET  /admin               ← Dashboard kelola slot
 *   POST /admin/slot/add      ← Tambah / perpanjang slot (auto-generate key)
 *   POST /admin/slot/remove   ← Hapus slot
 *   GET  /admin/slots         ← List slot (JSON)
 *
 * ENV Railway yang dibutuhkan:
 *   ADMIN_USER   – username login dashboard (default: admin)
 *   ADMIN_PASS   – password login dashboard  (WAJIB diset di Railway)
 *   PORT         – port server (Railway set otomatis)
 */

const express  = require("express");
const http     = require("http");
const { WebSocketServer, OPEN } = require("ws");
const url      = require("url");
const crypto   = require("crypto");

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

// ─── Config dari Railway ENV ──────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

if (!ADMIN_PASS) {
  console.warn("⚠️  WARNING: ADMIN_PASS env tidak diset! Dashboard admin tidak aman.");
}

// ─── In-memory store ──────────────────────────────────────────────────────────
/**
 * slots = Map<slotNumber, { createdAt, expiredAt, label, key }>
 *   expiredAt = null  → slot aktif selamanya
 *   key       = string 8 karakter alfanumerik random
 */
const slots    = new Map();
const snapshot = {};
const clients  = {};

// ─── Key Generator ────────────────────────────────────────────────────────────
/**
 * Generate key random 8 karakter: huruf besar + angka
 * Contoh: "Ahvem614", "X9Kp2Qwz"
 */
function generateKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let key = "";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    key += chars[bytes[i] % chars.length];
  }
  return key;
}

/**
 * Cari slot berdasarkan key
 * Return: slotNumber atau null
 */
function findSlotByKey(key) {
  for (const [num, s] of slots.entries()) {
    if (s.key === key) return num;
  }
  return null;
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function getClients(slot) {
  if (!clients[slot]) clients[slot] = new Set();
  return clients[slot];
}

function isSlotActive(slot) {
  const s = slots.get(slot);
  if (!s) return false;
  if (s.expiredAt === null) return true;
  return new Date() < new Date(s.expiredAt);
}

function fmtDate(d) {
  if (!d) return "∞ Selamanya";
  const dt = new Date(d);
  return dt.toLocaleString("id-ID", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function timeLeft(expiredAt) {
  if (!expiredAt) return "Selamanya";
  const ms = new Date(expiredAt) - Date.now();
  if (ms <= 0) return "EXPIRED";
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (d > 0) return `${d}h ${h}j lagi`;
  if (h > 0) return `${h}j ${m}m lagi`;
  return `${m} menit lagi`;
}

// ─── HTML halaman blocked ─────────────────────────────────────────────────────
function blockedPage(slotNum) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Akses Ditolak – Slot ${slotNum}</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0f;font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;overflow:hidden}
    body::before{content:'';position:fixed;inset:0;
      background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(239,68,68,.15) 0%,transparent 70%),
                 radial-gradient(ellipse 60% 40% at 80% 100%,rgba(168,85,247,.1) 0%,transparent 70%);
      pointer-events:none}
    .card{position:relative;text-align:center;padding:3rem 2.5rem;max-width:480px;width:90%;
          background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);
          border-radius:20px;backdrop-filter:blur(12px);
          box-shadow:0 8px 40px rgba(0,0,0,.5);animation:fadeUp .6s ease both}
    @keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    .icon{font-size:3rem;margin-bottom:1rem}
    .badge{display:inline-block;margin-bottom:1.2rem;padding:.3rem 1rem;
           font-size:.7rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;
           color:#fca5a5;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:999px}
    h1{font-size:1.6rem;font-weight:800;margin-bottom:.5rem;color:#fef2f2}
    .slot-num{font-size:2.5rem;font-weight:900;
              background:linear-gradient(135deg,#f87171,#fb923c);
              -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .desc{font-size:.9rem;color:#94a3b8;margin:.8rem 0 2rem;line-height:1.7}
    .tg-btn{display:inline-flex;align-items:center;gap:.55rem;padding:.7rem 1.6rem;border-radius:12px;
            background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-size:.9rem;font-weight:600;
            text-decoration:none;transition:opacity .2s,transform .2s}
    .tg-btn:hover{opacity:.88;transform:translateY(-2px)}
    .tg-btn svg{width:18px;height:18px;fill:#fff}
    .footer{margin-top:2rem;font-size:.7rem;color:#334155}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">🔒</div>
    <div class="badge">Akses Ditolak</div>
    <h1>Slot Tidak Dapat Diakses</h1>
    <div class="slot-num">#${slotNum}</div>
    <p class="desc">Slot ini <strong>belum terdaftar</strong> atau <strong>masa aktifnya telah habis</strong>.</p>
    <a class="tg-btn" href="https://t.me/ace_finder" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24"><path d="M9.04 15.594l-.392 5.522c.56 0 .803-.24 1.094-.528l2.625-2.507 5.44 3.966c.998.55 1.706.26 1.974-.918l3.578-16.7C23.76.99 22.89.6 21.918.998L1.116 8.874C-.275 9.424-.267 10.2.843 10.54l5.11 1.595 11.87-7.43c.56-.373 1.07-.166.65.207z"/></svg>
      @ace_finder
    </a>
    <div class="footer">© Space Evolution · All rights reserved</div>
  </div>
</body>
</html>`;
}

// ─── HTML Dashboard Admin ─────────────────────────────────────────────────────
function adminDashboardHTML() {
  const allSlots = [...slots.entries()].sort((a, b) => a[0] - b[0]);

  const rows = allSlots.map(([num, s]) => {
    const active  = isSlotActive(num);
    const status  = active ? "🟢 Aktif" : "🔴 Expired";
    const rowCls  = active ? "" : " style=\"opacity:.5\"";
    const expStr  = fmtDate(s.expiredAt);
    const left    = timeLeft(s.expiredAt);
    const conns   = (clients[num]?.size ?? 0);
    const heroes  = (snapshot[num]?.length ?? 0);
    return `<tr${rowCls}>
      <td><strong>#${num}</strong></td>
      <td>${s.label || "-"}</td>
      <td>${status}</td>
      <td>${expStr}</td>
      <td class="sisa">${left}</td>
      <td><code class="key-badge">${s.key}</code>
          <button class="btn-copy" onclick="copyKey('${s.key}')">📋</button></td>
      <td>${conns} ws / ${heroes} hero</td>
      <td>
        <form method="POST" action="/admin/slot/remove" style="display:inline">
          <input type="hidden" name="slot" value="${num}"/>
          <button class="btn-del" onclick="return confirm('Hapus slot #${num}?')">Hapus</button>
        </form>
      </td>
    </tr>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Admin – Slot Manager</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:#0d1117;color:#c9d1d9;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px}
    header{background:#161b22;border-bottom:1px solid #30363d;padding:1rem 2rem;display:flex;align-items:center;gap:1rem}
    header h1{font-size:1.1rem;font-weight:700;color:#f0f6ff}
    header .badge{padding:.2rem .7rem;border-radius:999px;font-size:.7rem;font-weight:700;
                  background:rgba(99,102,241,.2);color:#a5b4fc;border:1px solid rgba(99,102,241,.4)}
    .container{max-width:1200px;margin:0 auto;padding:2rem}
    .section{background:#161b22;border:1px solid #30363d;border-radius:12px;margin-bottom:1.5rem;overflow:hidden}
    .section-header{padding:1rem 1.5rem;border-bottom:1px solid #30363d;display:flex;align-items:center;gap:.5rem;font-weight:600;font-size:.9rem;color:#f0f6ff}
    .section-body{padding:1.5rem}
    .stats{display:flex;gap:1rem;flex-wrap:wrap;margin-bottom:1.5rem}
    .stat{flex:1;min-width:150px;background:#0d1117;border:1px solid #30363d;border-radius:10px;padding:1rem 1.2rem}
    .stat-val{font-size:1.8rem;font-weight:800;color:#f0f6ff}
    .stat-lbl{font-size:.72rem;color:#6e7681;text-transform:uppercase;letter-spacing:.08em}
    .form-grid{display:grid;grid-template-columns:1fr 1fr 2fr auto;gap:.8rem;align-items:end}
    label{display:block;font-size:.75rem;color:#8b949e;margin-bottom:.3rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em}
    input,select{width:100%;padding:.55rem .8rem;background:#0d1117;border:1px solid #30363d;border-radius:8px;color:#c9d1d9;font-size:.9rem;outline:none}
    input:focus,select:focus{border-color:#6366f1}
    .btn{padding:.55rem 1.2rem;border-radius:8px;font-size:.85rem;font-weight:600;border:none;cursor:pointer;transition:opacity .15s}
    .btn-add{background:#6366f1;color:#fff}
    .btn-add:hover{opacity:.85}
    .btn-del{background:rgba(239,68,68,.15);color:#f87171;border:1px solid rgba(239,68,68,.3);font-size:.78rem;padding:.3rem .7rem;border-radius:6px;cursor:pointer}
    .btn-del:hover{background:rgba(239,68,68,.25)}
    .btn-copy{background:none;border:none;cursor:pointer;font-size:.85rem;padding:.1rem .3rem;opacity:.7}
    .btn-copy:hover{opacity:1}
    table{width:100%;border-collapse:collapse}
    th,td{padding:.7rem 1rem;text-align:left;border-bottom:1px solid #21262d;font-size:.85rem}
    th{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:#6e7681;font-weight:700}
    tr:last-child td{border-bottom:none}
    tr:hover td{background:#0d1117}
    .key-badge{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:.2rem .6rem;
               font-family:monospace;font-size:.9rem;color:#7ee787;letter-spacing:.05em}
    .sisa{font-size:.78rem;color:#8b949e}
    .empty{text-align:center;padding:2rem;color:#6e7681}
    .toast{position:fixed;bottom:1.5rem;right:1.5rem;background:#238636;color:#fff;
           padding:.7rem 1.2rem;border-radius:8px;font-size:.85rem;opacity:0;
           transition:opacity .3s;pointer-events:none;z-index:999}
    .toast.show{opacity:1}
    @media(max-width:700px){.form-grid{grid-template-columns:1fr 1fr}table{font-size:.78rem}}
  </style>
</head>
<body>
  <header>
    <h1>🛡️ Slot Manager — Admin</h1>
    <div class="badge">Space Evolution</div>
  </header>
  <div class="container">

    <div class="stats">
      <div class="stat"><div class="stat-val">${slots.size}</div><div class="stat-lbl">Total Slot</div></div>
      <div class="stat"><div class="stat-val">${allSlots.filter(([n]) => isSlotActive(n)).length}</div><div class="stat-lbl">Aktif</div></div>
      <div class="stat"><div class="stat-val">${allSlots.filter(([n]) => !isSlotActive(n)).length}</div><div class="stat-lbl">Expired</div></div>
      <div class="stat"><div class="stat-val">${Object.values(clients).reduce((t, s) => t + (s?.size ?? 0), 0)}</div><div class="stat-lbl">WS Aktif</div></div>
    </div>

    <div class="section">
      <div class="section-header">➕ Tambah / Perpanjang Slot</div>
      <div class="section-body">
        <form method="POST" action="/admin/slot/add">
          <div class="form-grid">
            <div>
              <label>Nomor Slot</label>
              <input type="number" name="slot" min="1" max="9999" placeholder="cth: 7" required/>
            </div>
            <div>
              <label>Label (opsional)</label>
              <input type="text" name="label" placeholder="cth: User A"/>
            </div>
            <div>
              <label>Expired</label>
              <select name="expiry_type" id="expiry_type" onchange="toggleCustom(this.value)">
                <option value="7d">7 Hari</option>
                <option value="30d">30 Hari</option>
                <option value="90d">90 Hari</option>
                <option value="1y">1 Tahun</option>
                <option value="forever">Selamanya</option>
                <option value="custom">Custom Tanggal…</option>
              </select>
              <input type="datetime-local" name="custom_date" id="custom_date" style="margin-top:.5rem;display:none"/>
            </div>
            <div>
              <label>&nbsp;</label>
              <button class="btn btn-add" type="submit">Simpan Slot</button>
            </div>
          </div>
        </form>
        <p style="margin-top:.8rem;font-size:.8rem;color:#6e7681">
          ℹ️ Key 8 karakter akan di-generate otomatis. Jika slot sudah ada, key lama akan diganti dengan yang baru.
        </p>
      </div>
    </div>

    <div class="section">
      <div class="section-header">📋 Daftar Slot</div>
      ${slots.size === 0
        ? `<div class="empty">Belum ada slot terdaftar.</div>`
        : `<table>
          <thead>
            <tr>
              <th>Slot</th><th>Label</th><th>Status</th>
              <th>Expired At</th><th>Sisa</th><th>Key</th><th>Koneksi</th><th>Aksi</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`}
    </div>

  </div>

  <div class="toast" id="toast">✅ Key disalin!</div>

  <script>
    function toggleCustom(v){
      document.getElementById('custom_date').style.display = v==='custom' ? 'block' : 'none';
    }
    function copyKey(key){
      navigator.clipboard.writeText(key).then(() => {
        const t = document.getElementById('toast');
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 2000);
      });
    }
    setTimeout(() => location.reload(), 30000);
  </script>
</body>
</html>`;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireAdmin(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const base64     = authHeader.replace(/^Basic\s+/, "");
  let ok = false;
  try {
    const [u, p] = Buffer.from(base64, "base64").toString().split(":");
    ok = (u === ADMIN_USER && p === ADMIN_PASS && ADMIN_PASS !== "");
  } catch (_) {}
  if (!ok) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Slot Manager Admin"');
    return res.status(401).send("Login diperlukan.");
  }
  next();
}

function requireActiveSlot(req, res, next) {
  const slot = parseInt(req.params.slot, 10);
  if (isNaN(slot)) return res.status(400).json({ ok: false, error: "Invalid slot" });
  if (!isSlotActive(slot)) {
    const accept = req.headers["accept"] || "";
    if (accept.includes("text/html")) return res.status(403).send(blockedPage(slot));
    return res.status(403).json({ ok: false, error: `Slot #${slot} tidak aktif atau belum terdaftar.` });
  }
  next();
}

// ─── POST /auth/login ─────────────────────────────────────────────────────────
// Java kirim key → server balas slot number
// Body: { "key": "Ahvem614" }
// Response: { "ok": true, "slot": 3 }  atau  { "ok": false, "error": "..." }
app.post("/auth/login", (req, res) => {
  const key = (req.body.key || "").trim();

  if (!key || key.length !== 8) {
    return res.status(400).json({ ok: false, error: "Key tidak valid (harus 8 karakter)" });
  }

  const slot = findSlotByKey(key);

  if (slot === null) {
    console.log(`[AUTH] Key tidak ditemukan: ${key}`);
    return res.status(401).json({ ok: false, error: "Key tidak ditemukan" });
  }

  if (!isSlotActive(slot)) {
    console.log(`[AUTH] Key valid tapi slot #${slot} sudah expired: ${key}`);
    return res.status(403).json({ ok: false, error: `Slot #${slot} sudah expired. Hubungi admin.` });
  }

  console.log(`[AUTH] Login berhasil — key=${key} slot=${slot}`);
  res.json({ ok: true, slot, label: slots.get(slot).label || "" });
});

// ─── GET / ────────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>DomainBuy – Space Evolution</title>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:#0a0a0f;font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;overflow:hidden}
    body::before{content:'';position:fixed;inset:0;
      background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(99,102,241,.18) 0%,transparent 70%),
                 radial-gradient(ellipse 60% 40% at 80% 100%,rgba(168,85,247,.12) 0%,transparent 70%);
      pointer-events:none}
    .card{text-align:center;padding:3rem 2.5rem;max-width:480px;width:90%;
          background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);
          border-radius:20px;backdrop-filter:blur(12px);box-shadow:0 8px 40px rgba(0,0,0,.5);
          animation:fadeUp .6s ease both}
    @keyframes fadeUp{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:translateY(0)}}
    .badge{display:inline-block;margin-bottom:1.2rem;padding:.3rem 1rem;font-size:.7rem;
           font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#a5b4fc;
           background:rgba(99,102,241,.15);border:1px solid rgba(99,102,241,.3);border-radius:999px}
    .logo{font-size:2.2rem;font-weight:800;
          background:linear-gradient(135deg,#818cf8 0%,#c084fc 100%);
          -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:.4rem}
    .sub{font-size:.95rem;color:#94a3b8;margin-bottom:2rem;line-height:1.6}
    .divider{height:1px;background:rgba(255,255,255,.07);margin:1.5rem 0}
    .tg-btn{display:inline-flex;align-items:center;gap:.55rem;padding:.7rem 1.6rem;border-radius:12px;
            background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;font-size:.9rem;font-weight:600;
            text-decoration:none;transition:opacity .2s,transform .2s}
    .tg-btn:hover{opacity:.88;transform:translateY(-2px)}
    .tg-btn svg{width:18px;height:18px;fill:#fff}
    .footer{margin-top:2rem;font-size:.7rem;color:#334155}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🌌 Space Evolution</div>
    <div class="logo">DomainBuy</div>
    <p class="sub">Minimap Plug-In MLBB<br>by Space Evolution.</p>
    <div class="divider"></div>
    <a class="tg-btn" href="https://t.me/ace_finder" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24"><path d="M9.04 15.594l-.392 5.522c.56 0 .803-.24 1.094-.528l2.625-2.507 5.44 3.966c.998.55 1.706.26 1.974-.918l3.578-16.7C23.76.99 22.89.6 21.918.998L1.116 8.874C-.275 9.424-.267 10.2.843 10.54l5.11 1.595 11.87-7.43c.56-.373 1.07-.166.65.207z"/></svg>
      @ace_finder
    </a>
    <div class="footer">© Space Evolution · All rights reserved</div>
  </div>
</body>
</html>`);
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.get("/admin", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(adminDashboardHTML());
});

app.get("/admin/slots", requireAdmin, (req, res) => {
  const result = [...slots.entries()].map(([num, s]) => ({
    slot     : num,
    label    : s.label,
    key      : s.key,
    active   : isSlotActive(num),
    createdAt: s.createdAt,
    expiredAt: s.expiredAt ?? null,
    timeLeft : timeLeft(s.expiredAt),
    connections: clients[num]?.size ?? 0,
    heroes   : snapshot[num]?.length ?? 0,
  }));
  res.json({ ok: true, count: result.length, slots: result });
});

app.post("/admin/slot/add", requireAdmin, (req, res) => {
  const slotNum    = parseInt(req.body.slot, 10);
  const label      = (req.body.label || "").trim();
  const expiryType = req.body.expiry_type || "30d";
  const customDate = req.body.custom_date;

  if (isNaN(slotNum) || slotNum < 1) {
    return res.status(400).send("Nomor slot tidak valid.");
  }

  let expiredAt = null;
  if (expiryType !== "forever") {
    const base = new Date();
    if      (expiryType === "7d")    base.setDate(base.getDate() + 7);
    else if (expiryType === "30d")   base.setDate(base.getDate() + 30);
    else if (expiryType === "90d")   base.setDate(base.getDate() + 90);
    else if (expiryType === "1y")    base.setFullYear(base.getFullYear() + 1);
    else if (expiryType === "custom" && customDate) {
      const d = new Date(customDate);
      if (isNaN(d.getTime())) return res.status(400).send("Tanggal custom tidak valid.");
      base.setTime(d.getTime());
    }
    expiredAt = base.toISOString();
  }

  const existing = slots.get(slotNum);
  // Key selalu di-generate ulang saat slot dibuat/diperbarui
  const newKey = generateKey();

  slots.set(slotNum, {
    createdAt: existing?.createdAt || new Date().toISOString(),
    expiredAt,
    label,
    key: newKey,
  });

  console.log(`[ADMIN] Slot #${slotNum} ${existing ? "diperbarui" : "ditambahkan"} — key=${newKey} expired=${expiredAt ?? "selamanya"}`);
  res.redirect("/admin");
});

app.post("/admin/slot/remove", requireAdmin, (req, res) => {
  const slotNum = parseInt(req.body.slot, 10);
  if (isNaN(slotNum)) return res.status(400).send("Slot tidak valid.");

  slots.delete(slotNum);
  delete snapshot[slotNum];

  if (clients[slotNum]) {
    clients[slotNum].forEach((ws) => {
      if (ws.readyState === OPEN) ws.close(1008, `Slot #${slotNum} dihapus oleh admin.`);
    });
    delete clients[slotNum];
  }

  console.log(`[ADMIN] Slot #${slotNum} dihapus.`);
  res.redirect("/admin");
});

// ─── POST /push/:slot ─────────────────────────────────────────────────────────
app.post("/push/:slot", requireActiveSlot, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ ok: false, error: "Body must be array" });

  snapshot[slot] = data;

  const slotClients = getClients(slot);
  const msg = JSON.stringify({ event: "hero_update", payload: data });
  let sent = 0;
  slotClients.forEach((ws) => {
    if (ws.readyState === OPEN) { ws.send(msg); sent++; }
  });

  res.json({ ok: true, slot, count: data.length, forwarded: sent });
});

// ─── GET /get/:slot ───────────────────────────────────────────────────────────
app.get("/get/:slot", requireActiveSlot, (req, res) => {
  const slot = parseInt(req.params.slot, 10);
  res.json(snapshot[slot] ?? []);
});

// ─── GET /status ──────────────────────────────────────────────────────────────
app.get("/status", (req, res) => {
  const info = {};
  for (const slot of Object.keys(clients)) {
    const n = parseInt(slot);
    info[slot] = { active: isSlotActive(n), connected: getClients(n).size, heroes: (snapshot[n] ?? []).length };
  }
  res.json({ ok: true, totalSlots: slots.size, slots: info, uptime: Math.floor(process.uptime()) + "s" });
});

// ─── WebSocket /ws/:slot ──────────────────────────────────────────────────────
wss.on("connection", (ws, req) => {
  const parsed = url.parse(req.url);
  const parts  = parsed.pathname.split("/").filter(Boolean);
  const slot   = parseInt(parts[1], 10);

  if (isNaN(slot)) { ws.close(1008, "Invalid slot"); return; }

  if (!isSlotActive(slot)) {
    try {
      ws.send(JSON.stringify({ event: "error", code: "SLOT_INACTIVE", message: `Slot #${slot} tidak aktif.` }));
    } catch (_) {}
    ws.close(1008, `Slot #${slot} tidak aktif`);
    return;
  }

  const slotClients = getClients(slot);
  slotClients.add(ws);
  console.log(`[WS] Connect slot=${slot}, total=${slotClients.size}`);

  if (snapshot[slot] && snapshot[slot].length > 0) {
    ws.send(JSON.stringify({ event: "hero_update", payload: snapshot[slot] }));
  }

  const pingInterval = setInterval(() => { if (ws.readyState === OPEN) ws.ping(); }, 20000);
  const expiryCheck  = setInterval(() => {
    if (!isSlotActive(slot)) {
      try { ws.send(JSON.stringify({ event: "error", code: "SLOT_EXPIRED", message: `Slot #${slot} expired.` })); } catch (_) {}
      ws.close(1001, `Slot #${slot} expired`);
    }
  }, 60000);

  ws.on("close", () => { slotClients.delete(ws); clearInterval(pingInterval); clearInterval(expiryCheck); console.log(`[WS] Disconnect slot=${slot}, remaining=${slotClients.size}`); });
  ws.on("error", (err) => { console.error(`[WS] Error slot=${slot}:`, err.message); slotClients.delete(ws); clearInterval(pingInterval); clearInterval(expiryCheck); });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  const match = req.path.match(/(\d+)/);
  const slot  = match ? parseInt(match[1], 10) : 0;
  res.status(404).send(blockedPage(slot || "??"));
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Minimap Relay v3 (Key Auth) running on port ${PORT}`);
  console.log(`   POST /auth/login      ← Java login pakai key`);
  console.log(`   POST /push/:slot      ← C++ mod`);
  console.log(`   GET  /get/:slot       ← Android fallback`);
  console.log(`   WS   /ws/:slot        ← Android realtime`);
  console.log(`   GET  /status          ← health check`);
  console.log(`   GET  /admin           ← Dashboard admin`);
  console.log(`\n   Admin user : ${ADMIN_USER}`);
  console.log(`   Admin pass : ${ADMIN_PASS ? "[set dari ENV]" : "⚠️  BELUM DISET!"}\n`);
});

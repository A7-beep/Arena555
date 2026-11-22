'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const INDEX = path.join(__dirname, 'public', 'index.html');
const TZ = 'Asia/Tashkent';
const FIELDS = ['A', 'B', 'C'];
const PLAN_DAYS = { silver: 30, gold: 365 };

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- Baza (JSON fayl) ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
let db;
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { db = {}; }
db.secret = db.secret || crypto.randomBytes(32).toString('hex');
db.prices = Object.assign({ slot: 100000, silver: 300000, gold: 3000000, discount: 20 }, db.prices);
db.card = Object.assign({ number: '', holder: '' }, db.card);
db.bookings = db.bookings || [];
db.subs = db.subs || [];
db.nextId = db.nextId || 1;
let generated = null;
if (!process.env.ADMIN_PASSWORD && !db.pw) {
  generated = crypto.randomBytes(6).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  db.pw = { salt, hash: hashPw(generated, salt) };
}
function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
save();

/* ---------- Admin ---------- */
function checkPw(pw) {
  pw = String(pw || '');
  let expected, given;
  if (process.env.ADMIN_PASSWORD) {
    expected = hashPw(process.env.ADMIN_PASSWORD, 'arena555');
    given = hashPw(pw, 'arena555');
  } else {
    expected = db.pw.hash;
    given = hashPw(pw, db.pw.salt);
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}
const adminToken = () => crypto.createHmac('sha256', db.secret)
  .update('admin:' + (process.env.ADMIN_PASSWORD || db.pw.hash)).digest('hex');
function isLocal(req) {
  const ip = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').split(':')[0];
  return !req.headers['x-forwarded-for'] && !req.headers['forwarded'] &&
    (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') &&
    (host === 'localhost' || host === '127.0.0.1' || host === '[::1]');
}
function isAdmin(req) {
  if (isLocal(req)) return true;
  const t = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(t), b = Buffer.from(adminToken());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const fails = new Map();

/* ---------- Vaqt (Toshkent) ---------- */
function nowTz() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
}
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function weekDays() {
  const n = nowTz();
  const start = n.hour >= 23 ? addDays(n.date, 1) : n.date;
  return [...Array(7)].map((_, i) => addDays(start, i));
}

/* ---------- Yordamchilar ---------- */
const activeSub = phone => db.subs.find(s => s.phone === phone && s.status === 'active' && s.until > Date.now());
const latestSub = phone => [...db.subs].reverse().find(s =>
  s.phone === phone && (s.status === 'pending' || (s.status === 'active' && s.until > Date.now())));
const okClient = c => typeof c === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(c);
const okPhone = p => typeof p === 'string' && /^\d{9}$/.test(p);
const okName = n => typeof n === 'string' && n.trim().length >= 2 && n.trim().length <= 40;
const clean = n => n.trim().replace(/\s+/g, ' ');

function fail(code, msg) { return Object.assign(new Error(msg), { code }); }
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > 10000) { reject(fail(413, 'So‘rov juda katta')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch (e) { reject(fail(400, 'Noto‘g‘ri so‘rov')); }
    });
    req.on('error', reject);
  });
}

/* ---------- Server ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, m = req.method;

    if (m === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (!p.startsWith('/api/')) return send(res, 404, { error: 'Topilmadi' });

    /* ----- Ommaviy ----- */
    if (m === 'GET' && p === '/api/state') {
      const client = url.searchParams.get('client') || '';
      const phone = url.searchParams.get('phone') || '';
      const n = nowTz(), days = weekDays();
      const taken = db.bookings.filter(b => days.includes(b.date)).map(b => ({
        k: `${b.stadium}|${b.date}|${b.hour}`, mine: b.client === client, status: b.status
      }));
      const mine = db.bookings.filter(b => b.client === client && b.date >= n.date)
        .map(({ id, stadium, date, hour, price, status }) => ({ id, stadium, date, hour, price, status }));
      const s = okPhone(phone) ? latestSub(phone) : null;
      return send(res, 200, {
        now: n, days, prices: db.prices, card: db.card, taken, mine,
        sub: s ? { plan: s.plan, status: s.status, until: s.until } : null
      });
    }

    if (m === 'POST' && p === '/api/book') {
      const b = await readBody(req);
      const { stadium, date, hour } = b;
      if (!FIELDS.includes(stadium)) throw fail(400, 'Maydon noto‘g‘ri');
      if (!weekDays().includes(date)) throw fail(400, 'Bu sana uchun bron yopiq');
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw fail(400, 'Vaqt noto‘g‘ri');
      if (!okName(b.name)) throw fail(400, 'Ismingizni kiriting');
      if (!okPhone(b.phone)) throw fail(400, 'Telefon raqami 9 ta raqamdan iborat bo‘lishi kerak');
      if (!okClient(b.client)) throw fail(400, 'Qurilma aniqlanmadi');
      const n = nowTz();
      if (date === n.date && hour <= n.hour) throw fail(400, 'Bu vaqt o‘tib ketgan');
      if (db.bookings.some(x => x.stadium === stadium && x.date === date && x.hour === hour))
        throw fail(409, 'Bu vaqtni boshqa odam band qilib bo‘ldi');
      const pending = db.bookings.filter(x => x.status === 'pending' && x.date >= n.date &&
        (x.client === b.client || x.phone === b.phone)).length;
      if (pending >= 5) throw fail(429, 'Tasdiqlanmagan bronlar ko‘p. Admin tasdiqlashini kuting');
      const price = Math.round(db.prices.slot * (activeSub(b.phone) ? (100 - db.prices.discount) / 100 : 1));
      db.bookings.push({
        id: db.nextId++, stadium, date, hour, name: clean(b.name), phone: b.phone,
        client: b.client, price, status: 'pending', created: Date.now()
      });
      save();
      return send(res, 200, { ok: true, price });
    }

    if (m === 'POST' && p === '/api/cancel') {
      const b = await readBody(req);
      const i = db.bookings.findIndex(x => x.id === b.id && x.client === b.client);
      if (i < 0) throw fail(404, 'Bron topilmadi');
      db.bookings.splice(i, 1); save();
      return send(res, 200, { ok: true });
    }

    if (m === 'POST' && p === '/api/subscribe') {
      const b = await readBody(req);
      if (!PLAN_DAYS[b.plan]) throw fail(400, 'Obunani tanlang');
      if (!okName(b.name)) throw fail(400, 'Ismingizni kiriting');
      if (!okPhone(b.phone)) throw fail(400, 'Telefon raqami 9 ta raqamdan iborat bo‘lishi kerak');
      if (!okClient(b.client)) throw fail(400, 'Qurilma aniqlanmadi');
      if (latestSub(b.phone)) throw fail(409, 'Bu raqamda obuna bor yoki kutilmoqda');
      if (db.subs.filter(s => s.status === 'pending' && s.client === b.client).length >= 3)
        throw fail(429, 'Juda ko‘p so‘rov');
      db.subs.push({
        id: db.nextId++, plan: b.plan, name: clean(b.name), phone: b.phone, client: b.client,
        price: db.prices[b.plan], status: 'pending', until: null, created: Date.now()
      });
      save();
      return send(res, 200, { ok: true });
    }

    /* ----- Admin ----- */
    if (m === 'POST' && p === '/api/admin/login') {
      const ip = req.socket.remoteAddress || '?';
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > Date.now()) throw fail(429, 'Ko‘p urinish. Bir daqiqadan keyin qayta urining');
      const b = await readBody(req);
      if (!checkPw(b.password)) {
        f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
        fails.set(ip, f);
        throw fail(401, 'Parol noto‘g‘ri');
      }
      fails.delete(ip);
      return send(res, 200, { token: adminToken() });
    }

    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) throw fail(401, 'Ruxsat yo‘q');

      if (m === 'GET' && p === '/api/admin/data') {
        const n = nowTz();
        const bookings = db.bookings.filter(b => b.date >= n.date)
          .sort((a, b) => (a.date + String(a.hour).padStart(2, '0')).localeCompare(b.date + String(b.hour).padStart(2, '0')))
          .map(({ client, ...r }) => r);
        const subs = [...db.subs].reverse().slice(0, 200).map(({ client, ...s }) => ({
          ...s, status: s.status === 'active' && s.until <= Date.now() ? 'expired' : s.status
        }));
        return send(res, 200, { now: n, prices: db.prices, card: db.card, bookings, subs });
      }

      if (m === 'POST' && p === '/api/admin/booking') {
        const b = await readBody(req);
        const i = db.bookings.findIndex(x => x.id === b.id);
        if (i < 0) throw fail(404, 'Bron topilmadi');
        if (b.action === 'accept') db.bookings[i].status = 'accepted';
        else if (b.action === 'delete') db.bookings.splice(i, 1);
        else throw fail(400, 'Amal noto‘g‘ri');
        save(); return send(res, 200, { ok: true });
      }

      if (m === 'POST' && p === '/api/admin/sub') {
        const b = await readBody(req);
        const i = db.subs.findIndex(x => x.id === b.id);
        if (i < 0) throw fail(404, 'Obuna topilmadi');
        if (b.action === 'accept') {
          const s = db.subs[i];
          s.status = 'active'; s.until = Date.now() + PLAN_DAYS[s.plan] * 864e5;
        } else if (b.action === 'delete') db.subs.splice(i, 1);
        else throw fail(400, 'Amal noto‘g‘ri');
        save(); return send(res, 200, { ok: true });
      }

      if (m === 'POST' && p === '/api/admin/card') {
        const b = await readBody(req);
        const number = String(b.number || '').replace(/\D/g, '');
        const holder = String(b.holder || '').trim().replace(/\s+/g, ' ');
        if (number && number.length !== 16) throw fail(400, 'Karta raqami 16 ta raqamdan iborat bo‘lishi kerak');
        if (holder.length > 40) throw fail(400, 'Ism juda uzun');
        db.card = { number, holder };
        save(); return send(res, 200, { ok: true, card: db.card });
      }

      if (m === 'POST' && p === '/api/admin/prices') {
        const b = await readBody(req);
        const v = (x, max) => Number.isInteger(x) && x >= 0 && x <= max;
  uchun        if (!v(b.slot, 1e9) || !v(b.silver, 1e9) || !v(b.gold, 1e9) || !v(b.discount, 100))
          throw fail(400, 'Narxlar noto‘g‘ri');
        db.prices = { slot: b.slot, silver: b.silver, gold: b.gold, discount: b.discount };
        save(); return send(res, 200, { ok: true, prices: db.prices });
      }
    }

    return send(res, 404, { error: 'Topilmadi' });
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error(e);
    send(res, code, { error: code === 500 ? 'Server xatosi' : e.message });
  }
});

server.listen(PORT, () => {
  console.log(`Arena555 ishlayapti: http://localhost:${PORT}`);
  if (generated) {
    console.log('\n  ADMIN PAROLI (faqa

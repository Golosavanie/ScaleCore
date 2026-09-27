/* ============================================================
   ScaleCore — Backend (Express + JSON storage + Bark)
   ============================================================ */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'scalecore2025';
const BARK_URL = process.env.BARK_URL || 'https://api.day.app/2mfG6468JsmXaVLaLETob';
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

/* ---------- MIDDLEWARE ---------- */
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-password');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

/* ---------- DATA LAYER ---------- */
let data = { orders: [], reviews: [] };

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      data.orders = Array.isArray(parsed.orders) ? parsed.orders : [];
      data.reviews = Array.isArray(parsed.reviews) ? parsed.reviews : [];
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    }
  } catch (e) {
    console.error('❌ Data load error:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('❌ Data save error:', e.message);
  }
}

loadData();

/* ---------- ADMIN AUTH ---------- */
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.pass;
  if (pass && pass === ADMIN_PASSWORD) return next();
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

/* ---------- STATIC ---------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin.html', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

/* ============================================================
   API — AUTH
   ============================================================ */
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Неверный пароль' });
});

/* ============================================================
   API — ORDERS
   ============================================================ */
app.post('/api/orders', async (req, res) => {
  try {
    const { name, phone, type, budget, description } = req.body || {};
    if (!name || !phone || !description) {
      return res.status(400).json({ ok: false, error: 'Заполните имя, контакт и описание' });
    }

    const order = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(name).trim().slice(0, 120),
      phone: String(phone).trim().slice(0, 120),
      type: String(type || 'custom').slice(0, 40),
      budget: Number(budget) || 0,
      description: String(description).trim().slice(0, 2000),
      date: Date.now(),
      status: 'new',
      ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
      ua: String(req.headers['user-agent'] || '').slice(0, 300)
    };

    data.orders.unshift(order);
    saveData();

    // Bark уведомление (не блокирует ответ)
    sendBarkNotification(order).catch(e => console.warn('Bark:', e.message));

    res.json({ ok: true, id: order.id });
  } catch (e) {
    console.error('Order error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/api/orders', adminAuth, (req, res) => {
  res.json({ ok: true, orders: data.orders });
});

app.patch('/api/orders/:id', adminAuth, (req, res) => {
  const order = data.orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ ok: false, error: 'Not found' });
  const { status } = req.body || {};
  if (['new', 'accepted', 'rejected'].includes(status)) {
    order.status = status;
    saveData();
  }
  res.json({ ok: true, order });
});

app.delete('/api/orders/:id', adminAuth, (req, res) => {
  const before = data.orders.length;
  data.orders = data.orders.filter(o => o.id !== req.params.id);
  if (data.orders.length !== before) saveData();
  res.json({ ok: true });
});

/* ============================================================
   API — REVIEWS
   ============================================================ */
app.get('/api/reviews', (req, res) => {
  res.json({ ok: true, reviews: data.reviews });
});

app.post('/api/reviews', (req, res) => {
  try {
    const { name, rating, service, text } = req.body || {};
    if (!rating || !text) return res.status(400).json({ ok: false, error: 'Укажите оценку и текст' });
    const review = {
      id: crypto.randomBytes(8).toString('hex'),
      name: String(name || '').trim().slice(0, 80) || 'Аноним',
      rating: Math.max(1, Math.min(5, Number(rating) || 5)),
      service: String(service || 'Проект').slice(0, 60),
      text: String(text).trim().slice(0, 2000),
      date: Date.now()
    };
    data.reviews.unshift(review);
    saveData();
    res.json({ ok: true, id: review.id });
  } catch (e) {
    console.error('Review error:', e);
    res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.delete('/api/reviews/:id', adminAuth, (req, res) => {
  const before = data.reviews.length;
  data.reviews = data.reviews.filter(r => r.id !== req.params.id);
  if (data.reviews.length !== before) saveData();
  res.json({ ok: true });
});

/* ============================================================
   BARK NOTIFICATION
   ============================================================ */
async function sendBarkNotification(order) {
  const typeMap = {
    landing: 'Лендинг',
    corporate: 'Корпоративный сайт',
    shop: 'Интернет-магазин',
    webapp: 'Веб-приложение',
    custom: 'Другое / не знаю'
  };

  const dateStr = new Date(order.date).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const title = '🔥 Новая заявка ScaleCore';
  const body = [
    `👤 Имя: ${order.name}`,
    `📞 Контакт: ${order.phone}`,
    `📦 Проект: ${typeMap[order.type] || order.type}`,
    `💰 Бюджет: ${Number(order.budget).toLocaleString('ru-RU')} ₽`,
    `🕐 Время: ${dateStr}`,
    `📝 Задача: ${order.description}`
  ].join('\n');

  const url = `${BARK_URL}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=scalecore_order&ttl=600&level=timeSensitive&sound=alarm`;
  const resp = await fetch(url);
  console.log('📲 Bark →', resp.status);
}

/* ============================================================
   HEALTH + START
   ============================================================ */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    orders: data.orders.length,
    reviews: data.reviews.length,
    uptime: Math.round(process.uptime())
  });
});

app.listen(PORT, () => {
  console.log(`🚀 ScaleCore server on port ${PORT}`);
  console.log(`🔐 Admin password ${ADMIN_PASSWORD === 'scalecore2025' ? '(DEFAULT — смени через env!)' : 'set'}`);
  console.log(`📁 Data file: ${DATA_FILE}`);
});

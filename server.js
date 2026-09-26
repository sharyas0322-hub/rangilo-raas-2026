require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.join(__dirname, 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const CONFIG_FILE = path.join(DATA_DIR, 'event-config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCANNER_DIR = path.join(__dirname, 'scanner');
const ADMIN_DIR = path.join(__dirname, 'admin');
const TZ = 'Asia/Kolkata';
const BHARATPE_QR_FILE = path.join(PUBLIC_DIR, 'bharatpe-qr.jpg');
const BHARATPE_UPI_NAME = 'MOTI DEVI';

const PRICES = {
  'NORMAL SINGLE': 299,
  'NORMAL COUPLE': 499,
  'VIP SINGLE': 599,
  'VIP COUPLE': 999
};

const DEFAULT_CONFIG = {
  eventName: 'Rangilo Raas 2026',
  eventDates: ['2026-10-16', '2026-10-17'],
  eventTime: '5:00 PM – 11:00 PM',
  venueName: 'Aashirvadd Banquet Hall',
  venueAddress: 'Near Gai Ghat, Patna, Bihar',
  venueMapsUrl: 'https://maps.app.goo.gl/sHiKSQ9gZz1KkJwbA',
  ticketReleaseDate: '2026-10-13',
  ticketReleaseTime: '00:00',
  releaseOverride: true,
  lastReleasedAt: '',
  instantTicketRelease: true,
  testScanMode: false
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(TICKETS_FILE)) fs.writeFileSync(TICKETS_FILE, '[]');
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.includes('ChangeThis')) {
  console.warn('\n[WARNING] Set a strong ADMIN_PASSWORD before going live.\n');
}
if (!process.env.TICKET_SECRET || process.env.TICKET_SECRET.includes('Change_This')) {
  console.warn('\n[WARNING] Set a strong TICKET_SECRET before going live.\n');
}

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = String(process.env.SUPABASE_SECRET_KEY || '').trim();
const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_KEY);

if (SUPABASE_ENABLED) {
  console.log('[DATABASE] Supabase persistence enabled.');
} else {
  console.warn('[DATABASE] Supabase environment variables are missing. Local JSON storage will be used.');
}


function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readConfig() {
  return {
    ...DEFAULT_CONFIG,
    ...readJson(CONFIG_FILE, {}),
    venueName: 'Aashirvadd Banquet Hall',
    venueAddress: 'Near Gai Ghat, Patna, Bihar',
    venueMapsUrl: 'https://maps.app.goo.gl/sHiKSQ9gZz1KkJwbA',
    instantTicketRelease: true,
    releaseOverride: true
  };
}

function writeConfig(config) {
  writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, ...config });
}

function cleanType(type) {
  return String(type || '').toUpperCase().trim();
}

function getTicketId() {
  return 'RR26-' + Date.now().toString(36).toUpperCase() + '-' +
    crypto.randomBytes(3).toString('hex').toUpperCase();
}

function signTicket(ticketId) {
  return crypto
    .createHmac('sha256', process.env.TICKET_SECRET || 'change-me')
    .update(ticketId)
    .digest('hex');
}

function safeCompare(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function nowInIndia() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
}

function todayIndia() {
  const d = nowInIndia();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isoNow() {
  return new Date().toISOString();
}

function formatIndia(iso) {
  if (!iso) return '-';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(iso));
}

function validReleaseDate(d) {
  return /^2026-10-(0[1-9]|[12]\d|3[01])$/.test(String(d || ''));
}

function validReleaseTime(t) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || ''));
}

function releaseReady(config) {
  return Boolean(String(config.venueName || '').trim() &&
    String(config.venueAddress || '').trim());
}

function ticketReleased(config) {
  return true;
}

function publicConfig() {
  const config = readConfig();
  return {
    eventName: config.eventName,
    eventDates: config.eventDates,
    eventTime: config.eventTime,
    venueName: config.venueName,
    venueAddress: config.venueAddress,
    venueMapsUrl: config.venueMapsUrl,
    ticketReleaseDate: config.ticketReleaseDate,
    ticketReleaseTime: config.ticketReleaseTime,
    releaseReady: releaseReady(config),
    ticketReleased: ticketReleased(config),
    testMode: Number(process.env.TEST_FIXED_AMOUNT_RUPEES || 0) > 0,
    testScanMode: config.testScanMode === true
  };
}

function sessionToken() {
  return crypto
    .createHmac('sha256', process.env.ADMIN_PASSWORD || 'missing-admin')
    .update('rangilo-raas-admin-session-v1')
    .digest('hex');
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > -1) {
      out[part.slice(0, i).trim()] =
        decodeURIComponent(part.slice(i + 1).trim());
    }
  });
  return out;
}

function isAdmin(req) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) return false;

  const gotHeader = String(req.get('x-admin-password') || '');
  if (gotHeader && safeCompare(gotHeader, expected)) return true;

  const gotCookie = parseCookies(req).rr_admin || '';
  return !!gotCookie && safeCompare(gotCookie, sessionToken());
}

function requireAdmin(req, res, next) {
  if (!isAdmin(req)) {
    return res.status(401).json({ error: 'Admin authentication required.' });
  }
  next();
}

function getPeople(type, qty) {
  return Number(type.includes('COUPLE') ? 2 : 1) * qty;
}

function validEventDate(date) {
  return readConfig().eventDates.includes(date);
}

function setAdminCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `rr_admin=${encodeURIComponent(sessionToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
  );
}

/* ---------------- Supabase persistence ---------------- */

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function supabaseRequest(endpoint, options = {}) {
  if (!SUPABASE_ENABLED) {
    throw new Error('Supabase is not configured.');
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: supabaseHeaders(options.headers || {})
  });

  const text = await response.text();
  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail = data?.message || data?.hint || data?.details || data?.error || text;
    throw new Error(`Supabase ${response.status}: ${detail || 'Request failed'}`);
  }

  return data;
}

function dbTicket(ticket) {
  return {
    ticketId: ticket.ticketId,
    bookingId: ticket.bookingId || ticket.ticketId,
    event: ticket.event || 'Rangilo Raas 2026',
    eventDate: ticket.eventDate,
    eventDates: ticket.eventDates || '16–17 October 2026',
    type: ticket.type,
    qty: Number(ticket.qty),
    people: Number(ticket.people),
    amountRupees: Number(ticket.amountRupees),
    name: ticket.name,
    mobile: ticket.mobile,
    paymentId: ticket.paymentId || null,
    orderId: ticket.orderId || null,
    utr: ticket.utr || null,
    payment_status: ticket.paymentStatus || ticket.payment_status || 'PENDING',
    payment_submitted_at: ticket.paymentSubmittedAt || ticket.payment_submitted_at || null,
    payment_verified_at: ticket.paymentVerifiedAt || ticket.payment_verified_at || null,
    payment_rejected_at: ticket.paymentRejectedAt || ticket.payment_rejected_at || null,
    payment_rejection_reason: ticket.paymentRejectionReason || ticket.payment_rejection_reason || null,
    status: ticket.status || 'PENDING_PAYMENT',
    used: Boolean(ticket.used),
    createdAt: ticket.createdAt || isoNow(),
    scannedAt: ticket.scannedAt || null,
    scannedBy: ticket.scannedBy || null,
    scanHistory: Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [],
    signature: ticket.signature
  };
}

function normalizeTicket(row) {
  if (!row) return null;
  return {
    ...row,
    paymentStatus: row.paymentStatus || row.payment_status ||
      (String(row.status || '').toUpperCase() === 'CONFIRMED' || String(row.status || '').toUpperCase() === 'USED' ? 'VERIFIED' : 'PENDING'),
    paymentSubmittedAt: row.paymentSubmittedAt || row.payment_submitted_at || null,
    paymentVerifiedAt: row.paymentVerifiedAt || row.payment_verified_at || null,
    paymentRejectedAt: row.paymentRejectedAt || row.payment_rejected_at || null,
    paymentRejectionReason: row.paymentRejectionReason || row.payment_rejection_reason || null,
    qty: Number(row.qty),
    people: Number(row.people),
    amountRupees: Number(row.amountRupees),
    used: Boolean(row.used),
    scanHistory: Array.isArray(row.scanHistory) ? row.scanHistory : []
  };
}

async function getAllTickets() {
  if (!SUPABASE_ENABLED) return readJson(TICKETS_FILE, []);

  const rows = await supabaseRequest(
    'tickets?select=*&order=createdAt.desc',
    { method: 'GET' }
  );
  return Array.isArray(rows) ? rows.map(normalizeTicket) : [];
}

async function getTicketById(ticketId) {
  if (!SUPABASE_ENABLED) {
    return readJson(TICKETS_FILE, []).find(
      t => String(t.ticketId).toUpperCase() === String(ticketId).toUpperCase()
    ) || null;
  }

  const rows = await supabaseRequest(
    `tickets?ticketId=eq.${encodeURIComponent(ticketId)}&select=*`,
    { method: 'GET' }
  );
  return normalizeTicket(Array.isArray(rows) ? rows[0] : null);
}

async function getTicketByPaymentId(paymentId) {
  if (!SUPABASE_ENABLED) {
    return readJson(TICKETS_FILE, []).find(
      t => String(t.paymentId) === String(paymentId)
    ) || null;
  }

  const rows = await supabaseRequest(
    `tickets?paymentId=eq.${encodeURIComponent(paymentId)}&select=*`,
    { method: 'GET' }
  );
  return normalizeTicket(Array.isArray(rows) ? rows[0] : null);
}

async function getTicketByUtr(utr) {
  const clean = String(utr || '').trim();
  if (!clean) return null;

  if (!SUPABASE_ENABLED) {
    return readJson(TICKETS_FILE, []).find(
      t => String(t.utr || '').trim().toUpperCase() === clean.toUpperCase()
    ) || null;
  }

  const rows = await supabaseRequest(
    `tickets?utr=eq.${encodeURIComponent(clean)}&select=*`,
    { method: 'GET' }
  );
  return normalizeTicket(Array.isArray(rows) ? rows[0] : null);
}

async function insertTicket(ticket) {
  if (!SUPABASE_ENABLED) {
    const tickets = readJson(TICKETS_FILE, []);
    tickets.push(ticket);
    writeJson(TICKETS_FILE, tickets);
    return ticket;
  }

  const rows = await supabaseRequest('tickets', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(dbTicket(ticket))
  });

  return normalizeTicket(Array.isArray(rows) ? rows[0] : rows);
}

async function updateTicket(ticketId, patch) {
  if (!SUPABASE_ENABLED) {
    const tickets = readJson(TICKETS_FILE, []);
    const index = tickets.findIndex(
      t => String(t.ticketId).toUpperCase() === String(ticketId).toUpperCase()
    );
    if (index === -1) return null;
    tickets[index] = { ...tickets[index], ...patch };
    writeJson(TICKETS_FILE, tickets);
    return tickets[index];
  }

  const rows = await supabaseRequest(
    `tickets?ticketId=eq.${encodeURIComponent(ticketId)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch)
    }
  );

  return normalizeTicket(Array.isArray(rows) ? rows[0] : null);
}

async function markTicketUsed(ticketId, scanTime, staff, result) {
  const historyItem = { at: scanTime, staff, result };

  if (!SUPABASE_ENABLED) {
    const tickets = readJson(TICKETS_FILE, []);
    const index = tickets.findIndex(
      t => String(t.ticketId).toUpperCase() === String(ticketId).toUpperCase()
    );
    if (index === -1) return null;

    const ticket = tickets[index];
    ticket.scanHistory = Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [];

    if (ticket.used) {
      ticket.scanHistory.push(historyItem);
      writeJson(TICKETS_FILE, tickets);
      return { ticket, changed: false };
    }

    ticket.used = true;
    ticket.status = 'USED';
    ticket.scannedAt = scanTime;
    ticket.scannedBy = staff;
    ticket.scanHistory.push(historyItem);
    writeJson(TICKETS_FILE, tickets);
    return { ticket, changed: true };
  }

  // Atomic first-use update: only a ticket whose used=false can become USED.
  const rows = await supabaseRequest(
    `tickets?ticketId=eq.${encodeURIComponent(ticketId)}&used=eq.false`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        used: true,
        status: 'USED',
        scannedAt: scanTime,
        scannedBy: staff,
        scanHistory: [historyItem]
      })
    }
  );

  if (Array.isArray(rows) && rows.length > 0) {
    return { ticket: normalizeTicket(rows[0]), changed: true };
  }

  const current = await getTicketById(ticketId);
  if (!current) return null;

  const history = Array.isArray(current.scanHistory) ? current.scanHistory : [];
  history.push(historyItem);

  const updated = await updateTicket(ticketId, { scanHistory: history });
  return { ticket: updated || { ...current, scanHistory: history }, changed: false };
}

async function recordScanAttempt(ticketId, scanTime, staff, result) {
  const ticket = await getTicketById(ticketId);
  if (!ticket) return null;

  const history = Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [];
  history.push({ at: scanTime, staff, result });

  return await updateTicket(ticketId, { scanHistory: history });
}

/* ---------------- App ---------------- */

app.use(express.json({ limit: '100kb' }));
app.use(express.static(PUBLIC_DIR));
app.use('/scanner', express.static(SCANNER_DIR));
app.use('/admin', express.static(ADMIN_DIR));

app.get('/api/config', (req, res) => res.json(publicConfig()));

function isLoopbackRequest(req) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1';
}

app.post('/api/local-test-scan-mode', (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({
      success: false,
      error: 'Test Scan Mode is available only on the local computer.'
    });
  }

  const config = readConfig();
  config.testScanMode = req.body?.enabled === true;
  writeConfig(config);

  res.json({ success: true, testScanMode: config.testScanMode });
});

app.get('/api/local-test-scan-mode', (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ success: false, error: 'Local only.' });
  }

  res.json({
    success: true,
    testScanMode: readConfig().testScanMode === true
  });
});

app.get('/api/payment-qr', (req, res) => {
  if (!fs.existsSync(BHARATPE_QR_FILE)) {
    return res.status(404).send('BharatPe QR not configured.');
  }
  res.sendFile(BHARATPE_QR_FILE);
});

app.post('/api/create-booking', async (req, res) => {
  try {
    const type = cleanType(req.body.type);
    const qty = Number(req.body.qty);
    const name = String(req.body.name || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    const eventDate = String(req.body.eventDate || '').trim();

    if (!PRICES[type]) return res.status(400).json({ error: 'Invalid pass type.' });
    if (![1, 2].includes(qty)) return res.status(400).json({ error: 'Quantity must be 1 or 2.' });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required.' });
    }
    if (!validEventDate(eventDate)) {
      return res.status(400).json({ error: 'Please select a valid event date.' });
    }

    const fixed = Number(process.env.TEST_FIXED_AMOUNT_RUPEES || 0);
    const amountRupees = fixed > 0 ? fixed : PRICES[type] * qty;
    const ticketId = getTicketId();

    const ticket = {
      ticketId,
      bookingId: ticketId,
      event: 'Rangilo Raas 2026',
      eventDate,
      eventDates: '16–17 October 2026',
      type,
      qty,
      people: getPeople(type, qty),
      amountRupees,
      name,
      mobile,
      paymentId: null,
      orderId: null,
      utr: null,
      paymentStatus: 'PENDING',
      paymentSubmittedAt: null,
      paymentVerifiedAt: null,
      paymentRejectedAt: null,
      paymentRejectionReason: null,
      status: 'PENDING_PAYMENT',
      used: false,
      createdAt: isoNow(),
      scannedAt: null,
      scannedBy: null,
      scanHistory: [],
      signature: signTicket(ticketId)
    };

    const saved = await insertTicket(ticket);

    res.json({
      success: true,
      ticket: saved,
      amountRupees,
      people: ticket.people,
      upiName: BHARATPE_UPI_NAME,
      qrUrl: '/api/payment-qr'
    });
  } catch (err) {
    console.error('create-booking error:', err);
    res.status(500).json({ error: 'Could not create booking.' });
  }
});

app.post('/api/submit-utr', async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const mobile = String(req.body.mobile || '').trim();
    const utr = String(req.body.utr || '').trim();

    if (!ticketId || !/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ error: 'Booking ID and valid mobile are required.' });
    }
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(utr)) {
      return res.status(400).json({ error: 'Enter a valid UTR / transaction reference.' });
    }

    const ticket = await getTicketById(ticketId);
    if (!ticket || ticket.mobile !== mobile) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    if (ticket.paymentStatus === 'VERIFIED' && ticket.status === 'CONFIRMED') {
      return res.json({ success: true, status: 'CONFIRMED', ticket });
    }

    const duplicate = await getTicketByUtr(utr);
    if (duplicate && duplicate.ticketId !== ticketId) {
      return res.status(409).json({ error: 'This UTR has already been submitted for another booking.' });
    }

    const updated = await updateTicket(ticketId, {
      utr,
      payment_status: 'PENDING',
      payment_submitted_at: isoNow(),
      payment_verified_at: null,
      payment_rejected_at: null,
      payment_rejection_reason: null,
      status: 'PENDING_PAYMENT'
    });

    res.json({ success: true, status: 'PENDING', ticket: updated });
  } catch (err) {
    console.error('submit-utr error:', err);
    res.status(500).json({ error: 'Could not submit UTR.' });
  }
});

app.get('/api/admin/pending-payments', requireAdmin, async (req, res) => {
  try {
    const tickets = await getAllTickets();
    res.json({
      tickets: tickets.filter(t => t.paymentStatus === 'PENDING' && t.utr)
        .map(t => ({ ...t, signature: undefined }))
    });
  } catch (err) {
    console.error('pending-payments error:', err);
    res.status(500).json({ error: 'Could not load pending payments.' });
  }
});

app.post('/api/admin/verify-payment', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const ticket = await getTicketById(ticketId);

    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
    if (!ticket.utr) return res.status(400).json({ error: 'UTR has not been submitted.' });

    const duplicate = await getTicketByUtr(ticket.utr);
    if (duplicate && duplicate.ticketId !== ticketId) {
      return res.status(409).json({ error: 'This UTR belongs to another booking.' });
    }

    const updated = await updateTicket(ticketId, {
      payment_status: 'VERIFIED',
      payment_verified_at: isoNow(),
      payment_rejected_at: null,
      payment_rejection_reason: null,
      status: 'CONFIRMED',
      used: false
    });

    res.json({ success: true, ticket: updated });
  } catch (err) {
    console.error('verify-payment admin error:', err);
    res.status(500).json({ error: 'Could not verify payment.' });
  }
});

app.post('/api/admin/reject-payment', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const reason = String(req.body.reason || 'Payment could not be verified.').trim().slice(0, 200);
    const ticket = await getTicketById(ticketId);

    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    const updated = await updateTicket(ticketId, {
      payment_status: 'REJECTED',
      payment_rejected_at: isoNow(),
      payment_rejection_reason: reason,
      status: 'PENDING_PAYMENT'
    });

    res.json({ success: true, ticket: updated });
  } catch (err) {
    console.error('reject-payment admin error:', err);
    res.status(500).json({ error: 'Could not reject payment.' });
  }
});

async function qrPayload(ticket) {
  return JSON.stringify({
    ticketId: ticket.ticketId,
    sig: ticket.signature
  });
}

async function awaitQr(ticket) {
  return QRCode.toDataURL(await qrPayload(ticket), {
    width: 320,
    margin: 2,
    errorCorrectionLevel: 'M'
  });
}

app.get('/api/ticket/:ticketId/qr', async (req, res) => {
  try {
    const ticket = await getTicketById(req.params.ticketId);
    if (!ticket) return res.status(404).send('Ticket not found.');

    const mobile = String(req.query.mobile || '').trim();
    if (!mobile || mobile !== ticket.mobile) {
      return res.status(401).send('Unauthorized.');
    }

    if (ticket.paymentStatus !== 'VERIFIED' || ticket.status !== 'CONFIRMED') {
      return res.status(403).send('Payment is not verified yet.');
    }

    if (!ticketReleased(readConfig())) {
      return res.status(403).send('Ticket QR is not released yet.');
    }

    const png = await QRCode.toBuffer(await qrPayload(ticket), {
      type: 'png',
      width: 420,
      margin: 2,
      errorCorrectionLevel: 'M'
    });

    res.setHeader('Content-Type', 'image/png');
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    res.send(png);
  } catch (err) {
    console.error('QR image error:', err);
    res.status(500).send('Could not generate QR image.');
  }
});

app.get('/api/ticket/:ticketId', async (req, res) => {
  try {
    const ticket = await getTicketById(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    const mobile = String(req.query.mobile || '').trim();

    if (!mobile || mobile !== ticket.mobile) {
      return res.status(401).json({
        error: 'Booking ID and registered mobile number do not match.'
      });
    }

    const config = publicConfig();
    const safeTicket = { ...ticket };
    delete safeTicket.signature;

    const canShowQr =
      config.ticketReleased &&
      ticket.paymentStatus === 'VERIFIED' &&
      ticket.status === 'CONFIRMED';

    if (!config.ticketReleased || !canShowQr) {
      return res.json({
        released: false,
        ticket: safeTicket,
        qrDataUrl: null,
        config
      });
    }

    res.json({
      released: canShowQr,
      ticket: safeTicket,
      qrDataUrl: canShowQr && ticket.signature ? awaitQr(ticket) : null,
      config
    });
  } catch (err) {
    console.error('ticket lookup error:', err);
    res.status(500).json({ error: 'Could not load ticket.' });
  }
});

app.post('/api/manual-scan', async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const staff = String(req.body.staff || 'Gate Staff')
      .trim()
      .slice(0, 80) || 'Gate Staff';

    if (!ticketId) {
      return res.status(400).json({
        status: 'INVALID',
        message: 'Ticket ID is required.'
      });
    }

    const ticket = await getTicketById(ticketId);
    const scanTime = isoNow();

    if (!ticket) {
      return res.status(404).json({
        status: 'INVALID',
        message: 'Ticket ID not found.'
      });
    }

    const config = publicConfig();

    if (ticket.paymentStatus !== 'VERIFIED' || ticket.status !== 'CONFIRMED') {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'PAYMENT_NOT_VERIFIED_MANUAL'
      );
      return res.json({
        status: 'INVALID',
        message: 'Payment is not verified yet. Entry not allowed.',
        ticket: updated || ticket
      });
    }

    if (!config.ticketReleased) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'TICKET_NOT_RELEASED_MANUAL'
      );
      return res.json({
        status: 'INVALID',
        message: 'Scanner is not active yet. Ticket/venue release is pending.',
        ticket: updated || ticket
      });
    }

    if (!validEventDate(ticket.eventDate)) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'INVALID_EVENT_DATE_MANUAL'
      );
      return res.json({
        status: 'INVALID',
        message: 'Invalid event date on ticket.',
        ticket: updated || ticket
      });
    }

    if (ticket.eventDate !== todayIndia() && !config.testScanMode) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'WRONG_DATE_MANUAL'
      );
      return res.json({
        status: 'INVALID_DATE',
        message: `Ticket is valid only for ${ticket.eventDate}. Today is ${todayIndia()}.`,
        ticket: updated || ticket
      });
    }

    const result = await markTicketUsed(
      ticketId, scanTime, staff, 'VALID_MANUAL'
    );

    if (!result) {
      return res.status(404).json({
        status: 'INVALID',
        message: 'Ticket not found.'
      });
    }

    if (!result.changed) {
      return res.json({
        status: 'ALREADY_USED',
        message: 'ALREADY SCANNED — this ticket has already been used.',
        ticket: result.ticket
      });
    }

    res.json({
      status: 'VALID',
      message: 'Entry approved. Ticket marked as used.',
      ticket: result.ticket
    });
  } catch (err) {
    console.error('manual scan error:', err);
    res.status(500).json({
      status: 'ERROR',
      message: 'Manual verification error.'
    });
  }
});

app.post('/api/scan', async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim();
    const sig = String(req.body.sig || '').trim();
    const staff = String(req.body.staff || 'Gate Staff')
      .trim()
      .slice(0, 80) || 'Gate Staff';

    if (!ticketId || !sig) {
      return res.status(400).json({
        status: 'INVALID',
        message: 'QR data incomplete.'
      });
    }

    if (!safeCompare(sig, signTicket(ticketId))) {
      return res.status(400).json({
        status: 'INVALID',
        message: 'Invalid QR signature.'
      });
    }

    const ticket = await getTicketById(ticketId);

    if (!ticket) {
      return res.status(404).json({
        status: 'INVALID',
        message: 'Ticket not found.'
      });
    }

    const config = publicConfig();
    const scanTime = isoNow();

    if (ticket.paymentStatus !== 'VERIFIED' || ticket.status !== 'CONFIRMED') {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'PAYMENT_NOT_VERIFIED'
      );
      return res.json({
        status: 'INVALID',
        message: 'Payment is not verified yet. Entry not allowed.',
        ticket: updated || ticket
      });
    }

    if (!config.ticketReleased) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'TICKET_NOT_RELEASED'
      );
      return res.json({
        status: 'INVALID',
        message: 'Scanner is not active yet. Ticket/venue release is pending.',
        ticket: updated || ticket
      });
    }

    if (!validEventDate(ticket.eventDate)) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'INVALID_EVENT_DATE'
      );
      return res.json({
        status: 'INVALID',
        message: 'Invalid event date on ticket.',
        ticket: updated || ticket
      });
    }

    if (ticket.eventDate !== todayIndia() && !config.testScanMode) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'WRONG_DATE'
      );
      return res.json({
        status: 'INVALID_DATE',
        message: `Ticket is valid only for ${ticket.eventDate}. Today is ${todayIndia()}.`,
        ticket: updated || ticket
      });
    }

    const result = await markTicketUsed(
      ticketId, scanTime, staff, 'VALID'
    );

    if (!result) {
      return res.status(404).json({
        status: 'INVALID',
        message: 'Ticket not found.'
      });
    }

    if (!result.changed) {
      return res.json({
        status: 'ALREADY_USED',
        message: 'ALREADY SCANNED — this ticket has already been used.',
        ticket: result.ticket
      });
    }

    res.json({
      status: 'VALID',
      message: 'Entry approved. Ticket marked as used.',
      ticket: result.ticket
    });
  } catch (err) {
    console.error('scan error:', err);
    res.status(500).json({
      status: 'ERROR',
      message: 'Scanner error.'
    });
  }
});

/* ---------------- Admin ---------------- */

app.get('/api/admin/me', requireAdmin, async (req, res) => {
  res.json({
    success: true,
    config: { ...readConfig(), ...publicConfig() }
  });
});

app.post('/api/admin/login', (req, res) => {
  const password = String(req.body.password || '');

  if (!process.env.ADMIN_PASSWORD ||
      !safeCompare(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({
      error: 'Invalid admin password.'
    });
  }

  setAdminCookie(res);

  res.json({
    success: true,
    config: { ...readConfig(), ...publicConfig() }
  });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.setHeader(
    'Set-Cookie',
    'rr_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'
  );
  res.json({ success: true });
});

/*
  The current admin UI only needs booking/payment/scanner information.
  Venue and ticket-release controls are intentionally not exposed here.
*/

app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
  try {
    const tickets = (await getAllTickets()).map(t => ({
      ...t,
      signature: undefined
    }));

    const scans = tickets.reduce(
      (n, t) => n + (Array.isArray(t.scanHistory) ? t.scanHistory.length : 0),
      0
    );

    const used = tickets.filter(t => t.used).length;

    res.json({
      tickets,
      config: publicConfig(),
      summary: {
        paid: tickets.filter(t => t.paymentStatus === 'VERIFIED').length,
        used,
        unused: tickets.length - used,
        scanAttempts: scans
      }
    });
  } catch (err) {
    console.error('admin tickets error:', err);
    res.status(500).json({
      error: 'Could not load bookings.'
    });
  }
});

app.get('/api/admin/export.csv', requireAdmin, async (req, res) => {
  try {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const rows = [[
      'Ticket ID',
      'Name',
      'Mobile',
      'Event Date',
      'Pass',
      'Qty',
      'People',
      'Amount',
      'UTR',
      'Payment Status',
      'Payment Submitted At',
      'Payment Verified At',
      'Status',
      'First Entry (IST)',
      'Scans'
    ]];

    const tickets = await getAllTickets();

    for (const t of tickets) {
      rows.push([
        t.ticketId,
        t.name,
        t.mobile,
        t.eventDate,
        t.type,
        t.qty,
        t.people,
        t.amountRupees,
        t.utr || '',
        t.paymentStatus || 'PENDING',
        formatIndia(t.paymentSubmittedAt),
        formatIndia(t.paymentVerifiedAt),
        t.status,
        formatIndia(t.scannedAt),
        Array.isArray(t.scanHistory) ? t.scanHistory.length : 0
      ]);
    }

    const csv = rows.map(row => row.map(esc).join(',')).join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="rangilo-raas-bookings.csv"'
    );
    res.send('\uFEFF' + csv);
  } catch (err) {
    console.error('admin export error:', err);
    res.status(500).send('Could not export bookings.');
  }
});

/* Backward-compatible admin config endpoint.
   The current UI does not expose venue/release controls. */
app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ ...readConfig(), ...publicConfig() });
});

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    time: isoNow(),
    database: SUPABASE_ENABLED ? 'supabase' : 'local-json'
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server-key.pem');
const CERT_FILE = path.join(CERT_DIR, 'server-cert.pem');
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);

app.listen(PORT, HOST, () => {
  console.log(`\nRangilo Raas HTTP server running: http://localhost:${PORT}`);
  console.log(`LAN HTTP: http://<LAPTOP-IP>:${PORT}/scanner/`);
  console.log(`Admin: http://localhost:${PORT}/admin/`);
  console.log(
    `Test fixed amount: ₹${Number(process.env.TEST_FIXED_AMOUNT_RUPEES || 0) || 'normal ticket price'}`
  );
  console.log(`Database: ${SUPABASE_ENABLED ? 'Supabase' : 'Local JSON'}`);
  console.log(`Listening on ${HOST}:${PORT}`);
});

// HTTPS is only for local LAN camera testing.
// Render provides HTTPS automatically on the public URL.
try {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    https.createServer({
      key: fs.readFileSync(KEY_FILE),
      cert: fs.readFileSync(CERT_FILE)
    }, app).listen(HTTPS_PORT, HOST, () => {
      console.log(`HTTPS local scanner: https://<LAPTOP-IP>:${HTTPS_PORT}/scanner/`);
      console.log(`HTTPS listening on ${HOST}:${HTTPS_PORT}`);
    });
  } else {
    console.warn(
      '[WARNING] HTTPS certificate files missing. Mobile camera requires HTTPS.'
    );
  }
} catch (e) {
  console.error('[WARNING] Could not start HTTPS server:', e.message);
}

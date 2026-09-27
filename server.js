require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

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
  'NORMAL COUPLE': 549,
  'GROUP PASS': 999,
  'VIP COUPLE': 699
};

const DEFAULT_CONFIG = {
  eventName: 'Rangilo Raas 2026',
  eventDates: ['2026-10-17'],
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
  console.warn('\n[WARNING] Set ADMIN_PASSWORD in Render Environment before going live.\n');
}
if (!process.env.ADMIN_USER) {
  console.warn('\n[WARNING] ADMIN_USER not set; defaulting to admin.\n');
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
    testMode: false,
    testScanMode: config.testScanMode === true
  };
}

function sessionToken() {
  return crypto
    .createHmac('sha256', process.env.ADMIN_PASSWORD || 'missing-admin')
    .update(`rangilo-raas-admin-session-v2:${process.env.ADMIN_USER || 'admin'}`)
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
  const perPass = type === 'GROUP PASS' ? 4 : (type.includes('COUPLE') ? 2 : 1);
  return perPass * qty;
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
    eventDates: ticket.eventDates || '17 October 2026',
    type: ticket.type,
    qty: Number(ticket.qty),
    people: Number(ticket.people),
    amountRupees: Number(ticket.amountRupees),
    received_amount_rupees: ticket.receivedAmountRupees ?? ticket.received_amount_rupees ?? null,
    name: ticket.name,
    mobile: ticket.mobile,
    email: ticket.email || null,
    paymentId: ticket.paymentId || null,
    orderId: ticket.orderId || null,
    utr: ticket.utr || null,
    payment_screenshot: ticket.paymentScreenshot || ticket.payment_screenshot || null,
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
    email: row.email || null,
    paymentScreenshot: row.paymentScreenshot || row.payment_screenshot || null,
    receivedAmountRupees: row.receivedAmountRupees ?? row.received_amount_rupees ?? null,
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

async function getTicketByMobile(mobile) {
  const clean = String(mobile || '').trim();
  if (!clean) return null;
  if (!SUPABASE_ENABLED) {
    const tickets = readJson(TICKETS_FILE, []);
    return tickets.find(t => String(t.mobile || '').trim() === clean) || null;
  }
  const rows = await supabaseRequest(
    `tickets?mobile=eq.${encodeURIComponent(clean)}&select=*&order=createdAt.desc&limit=1`,
    { method: 'GET' }
  );
  return normalizeTicket(Array.isArray(rows) ? rows[0] : null);
}

async function getTicketByMobileAndEmail(mobile, email) {
  const cleanMobile = String(mobile || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanMobile || !cleanEmail) return null;

  if (!SUPABASE_ENABLED) {
    const tickets = readJson(TICKETS_FILE, []);
    return tickets
      .filter(t => String(t.mobile || '').trim() === cleanMobile &&
        String(t.email || '').trim().toLowerCase() === cleanEmail)
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  }

  const rows = await supabaseRequest(
    `tickets?mobile=eq.${encodeURIComponent(cleanMobile)}&email=eq.${encodeURIComponent(cleanEmail)}&select=*&order=createdAt.desc&limit=1`,
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

async function deleteTicketById(ticketId) {
  const clean = String(ticketId || '').trim().toUpperCase();
  if (!clean) return false;

  if (!SUPABASE_ENABLED) {
    const tickets = readJson(TICKETS_FILE, []);
    const next = tickets.filter(t => String(t.ticketId || '').toUpperCase() !== clean);
    if (next.length === tickets.length) return false;
    writeJson(TICKETS_FILE, next);
    return true;
  }

  await supabaseRequest(
    `tickets?ticketId=eq.${encodeURIComponent(clean)}`,
    { method: 'DELETE' }
  );
  return true;
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

app.use(express.json({ limit: '2mb' }));
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


async function makeTicketPdfBuffer(ticket) {
  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 0,
        info: {
          Title: 'Rangilo Raas 2026 E-Ticket',
          Author: 'Rangilo Raas'
        }
      });
      const chunks = [];
      doc.on('data', d => chunks.push(d));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595.28;
      const H = 841.89;
      const M = 36;
      const maroon = '#8d1832';
      const dark = '#241820';
      const muted = '#6f6570';
      const gold = '#d6a33a';
      const light = '#fbf7f3';
      const pale = '#f4e8df';
      const green = '#16734a';

      // Background
      doc.rect(0, 0, W, H).fill('#ffffff');

      // Festive top header
      doc.rect(0, 0, W, 118).fill(maroon);
      doc.fillColor('#ffffff')
        .font('Helvetica-Bold')
        .fontSize(27)
        .text('RANGILO RAAS', 0, 25, { width: W, align: 'center' });
      doc.font('Helvetica')
        .fontSize(12)
        .fillColor('#f8e8cf')
        .text('DANDIYA NIGHT 2026  •  PATNA', 0, 61, { width: W, align: 'center' });

      // Gold divider / festive dots
      doc.rect(165, 87, 265, 2).fill(gold);
      [175, 210, 245, 350, 385, 420].forEach(x => {
        doc.circle(x, 88, 3).fill(gold);
      });

      // Ticket badge
      doc.roundedRect(M, 102, W - 2 * M, 58, 10).fill('#ffffff');
      doc.roundedRect(M + 2, 104, W - 2 * M - 4, 54, 8).stroke(pale);
      doc.fillColor(maroon)
        .font('Helvetica-Bold')
        .fontSize(19)
        .text('E-TICKET', M + 16, 116);
      doc.fillColor(muted)
        .font('Helvetica')
        .fontSize(9)
        .text('BOOKING / TICKET ID', M + 16, 139);
      doc.fillColor(dark)
        .font('Helvetica-Bold')
        .fontSize(11)
        .text(String(ticket.ticketId || '-'), M + 115, 137);
      doc.fillColor(green)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(String(ticket.paymentStatus || 'VERIFIED').toUpperCase(), W - M - 100, 124, {
          width: 84,
          align: 'right'
        });

      // Main information card
      const cardY = 178;
      const cardH = 330;
      doc.roundedRect(M, cardY, W - 2 * M, cardH, 12).fill(light);
      doc.roundedRect(M, cardY, W - 2 * M, cardH, 12).stroke('#eadbd0');

      // Customer section
      doc.fillColor(maroon).font('Helvetica-Bold').fontSize(11)
        .text('GUEST DETAILS', M + 18, cardY + 18);
      doc.moveTo(M + 18, cardY + 37).lineTo(W - M - 18, cardY + 37)
        .lineWidth(0.7).stroke('#eadbd0');

      const leftX = M + 18;
      const rightX = 315;
      const label = (x, y, title, value, width = 245) => {
        doc.fillColor(muted).font('Helvetica').fontSize(8).text(title.toUpperCase(), x, y);
        doc.fillColor(dark).font('Helvetica-Bold').fontSize(12).text(String(value || '-'), x, y + 11, {
          width,
          ellipsis: true
        });
      };

      label(leftX, cardY + 53, 'Name', ticket.name);
      label(rightX, cardY + 53, 'Mobile', ticket.mobile);
      label(leftX, cardY + 92, 'Email', ticket.email || '-');
      label(rightX, cardY + 92, 'Pass Type', ticket.type);
      label(leftX, cardY + 131, 'Entry For', String(ticket.people || 1) + ' Person(s)');
      label(rightX, cardY + 131, 'Ticket Value', '₹' + Number(ticket.amountRupees || 0).toLocaleString('en-IN'));

      // Event highlight row
      doc.roundedRect(leftX, cardY + 177, W - 2 * M - 36, 66, 9).fill('#ffffff');
      doc.roundedRect(leftX, cardY + 177, W - 2 * M - 36, 66, 9).stroke('#eadbd0');

      doc.fillColor(maroon).font('Helvetica-Bold').fontSize(9)
        .text('17 OCTOBER 2026', leftX + 13, cardY + 190);
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(15)
        .text('5:00 PM – 11:00 PM', leftX + 13, cardY + 207);

      doc.fillColor(muted).font('Helvetica').fontSize(8)
        .text('VENUE', 330, cardY + 190);
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(10)
        .text('Aashirvadd Banquet Hall', 330, cardY + 202, { width: 190 });
      doc.fillColor(muted).font('Helvetica').fontSize(8)
        .text('Near Gai Ghat, Patna, Bihar', 330, cardY + 217, { width: 190 });

      // Gate row
      doc.fillColor(muted).font('Helvetica').fontSize(8).text('ENTRY GATE', leftX, cardY + 263);
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(12)
        .text('Gate No. 1 — Main Entry', leftX, cardY + 275);
      doc.fillColor(green).font('Helvetica-Bold').fontSize(9)
        .text('✓ PAYMENT VERIFIED', W - M - 150, cardY + 278, { width: 132, align: 'right' });

      // QR section
      const qrY = 535;
      doc.roundedRect(M, qrY, W - 2 * M, 205, 12).fill('#ffffff');
      doc.roundedRect(M, qrY, W - 2 * M, 205, 12).stroke('#eadbd0');

      doc.fillColor(maroon).font('Helvetica-Bold').fontSize(12)
        .text('SCAN FOR ENTRY', M + 20, qrY + 17);
      doc.fillColor(muted).font('Helvetica').fontSize(9)
        .text('Show this QR code at the gate. Keep your Booking ID safe.', M + 20, qrY + 37, {
          width: 260
        });

      // Generate and embed the same signed QR used by the scanner.
      const qrPng = await QRCode.toBuffer(await qrPayload(ticket), {
        type: 'png',
        width: 145,
        margin: 1,
        errorCorrectionLevel: 'M'
      });

      const qrX = W - M - 172;
      const qrBoxY = qrY + 17;
      doc.roundedRect(qrX, qrBoxY, 152, 152, 8).fill('#ffffff');
      doc.image(qrPng, qrX + 8, qrBoxY + 8, { width: 136, height: 136 });

      doc.fillColor(dark).font('Helvetica-Bold').fontSize(9)
        .text(String(ticket.ticketId || '-'), M + 20, qrY + 76, {
          width: 260,
          align: 'left'
        });
      doc.fillColor(muted).font('Helvetica').fontSize(8.5)
        .text('Valid for one entry • Gate No. 1', M + 20, qrY + 95);
      doc.fillColor(maroon).font('Helvetica-Bold').fontSize(10)
        .text('MY TICKET  •  RANGILO RAAS 2026', M + 20, qrY + 128);

      // Footer
      doc.rect(0, H - 58, W, 58).fill(maroon);
      doc.fillColor('#f8e8cf').font('Helvetica-Bold').fontSize(9)
        .text('KEEP THIS E-TICKET SAFE', M, H - 43);
      doc.fillColor('#ffffff').font('Helvetica').fontSize(8)
        .text('Present the QR code at the entrance. Entry is subject to ticket verification.', M, H - 29, {
          width: W - 2 * M
        });

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
app.post('/api/create-booking', async (req, res) => {
  try {
    const type = cleanType(req.body.type);
    const qty = Number(req.body.qty);
    const name = String(req.body.name || '').trim();
    const mobile = String(req.body.mobile || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const eventDate = String(req.body.eventDate || '').trim();

    if (!PRICES[type]) return res.status(400).json({ error: 'Invalid pass type.' });
    if (![1, 2].includes(qty)) return res.status(400).json({ error: 'Quantity must be 1 or 2.' });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ error: 'Valid 10-digit mobile number is required.' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email address is required.' });
    }
    if (!validEventDate(eventDate)) {
      return res.status(400).json({ error: 'Please select a valid event date.' });
    }

    const existing = await getTicketByMobile(mobile);
    if (existing) {
      return res.status(409).json({
        error: `This mobile number already has a booking. Booking ID: ${existing.ticketId}. Please use MY TICKET.`
      });
    }

    const amountRupees = PRICES[type] * qty;
    const ticketId = getTicketId();

    const ticket = {
      ticketId,
      bookingId: ticketId,
      event: 'Rangilo Raas 2026',
      eventDate,
      eventDates: '17 October 2026',
      type,
      qty,
      people: getPeople(type, qty),
      amountRupees,
      receivedAmountRupees: null,
      name,
      mobile,
      email,
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

app.post('/api/retrieve-booking', async (req, res) => {
  try {
    const mobile = String(req.body.mobile || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();

    if (!/^[6-9]\d{9}$/.test(mobile) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter the same 10-digit mobile number and email used during booking.' });
    }

    const ticket = await getTicketByMobileAndEmail(mobile, email);
    if (!ticket) {
      return res.status(404).json({ error: 'No booking found for this mobile number and email.' });
    }

    const safeTicket = { ...ticket };
    delete safeTicket.signature;

    res.json({
      success: true,
      ticket: safeTicket,
      resumePayment: ticket.paymentStatus !== 'VERIFIED' && ticket.status === 'PENDING_PAYMENT'
    });
  } catch (err) {
    console.error('retrieve-booking error:', err);
    res.status(500).json({ error: 'Could not retrieve the booking.' });
  }
});

app.post('/api/submit-utr', async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const mobile = String(req.body.mobile || '').trim();
    const utr = String(req.body.utr || '').trim();
    const paymentScreenshot = String(req.body.paymentScreenshot || '').trim();

    if (!ticketId || !/^[6-9]\d{9}$/.test(mobile)) {
      return res.status(400).json({ error: 'Booking ID and valid mobile are required.' });
    }
    const hasUtr = /^[A-Za-z0-9_-]{6,40}$/.test(utr);
    const hasScreenshot = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(paymentScreenshot) && paymentScreenshot.length <= 1800000;
    if (!hasUtr && !hasScreenshot) {
      return res.status(400).json({ error: 'Submit either a valid UTR / transaction reference or a payment screenshot.' });
    }

    const ticket = await getTicketById(ticketId);
    if (!ticket || ticket.mobile !== mobile) {
      return res.status(404).json({ error: 'Booking not found.' });
    }

    if (ticket.paymentStatus === 'VERIFIED' && ticket.status === 'CONFIRMED') {
      return res.json({ success: true, status: 'CONFIRMED', ticket });
    }

    const duplicate = hasUtr ? await getTicketByUtr(utr) : null;
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
      payment_screenshot: paymentScreenshot,
      status: 'PENDING_PAYMENT'
    });

    res.json({ success: true, status: 'PENDING', ticket: updated });
  } catch (err) {
    console.error('submit-utr error:', err);
    res.status(500).json({ error: 'Could not submit UTR.' });
  }
});

app.get('/api/admin/payment-screenshot/:ticketId', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId || '').trim().toUpperCase();
    const ticket = await getTicketById(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
    if (!ticket.paymentScreenshot) return res.status(404).json({ error: 'Payment screenshot not uploaded.' });
    res.json({ ticketId: ticket.ticketId, image: ticket.paymentScreenshot });
  } catch (err) {
    console.error('payment screenshot error:', err);
    res.status(500).json({ error: 'Could not load payment screenshot.' });
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

app.get('/api/admin/awaiting-payment', requireAdmin, async (req, res) => {
  try {
    const tickets = await getAllTickets();
    res.json({
      tickets: tickets
        .filter(t => t.paymentStatus === 'PENDING' && !t.utr)
        .map(t => ({ ...t, signature: undefined }))
    });
  } catch (err) {
    console.error('awaiting-payment error:', err);
    res.status(500).json({ error: 'Could not load bookings awaiting payment.' });
  }
});

app.post('/api/admin/verify-payment', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const receivedAmount = Number(req.body.receivedAmountRupees);
    const ticket = await getTicketById(ticketId);

    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
    if (!ticket.utr) return res.status(400).json({ error: 'UTR has not been submitted.' });
    if (!Number.isFinite(receivedAmount) || receivedAmount <= 0) {
      return res.status(400).json({ error: 'Enter the actual amount received before VERIFY.' });
    }

    const duplicate = await getTicketByUtr(ticket.utr);
    if (duplicate && duplicate.ticketId !== ticketId) {
      return res.status(409).json({ error: 'This UTR belongs to another booking.' });
    }

    const updated = await updateTicket(ticketId, {
      received_amount_rupees: receivedAmount,
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

app.post('/api/admin/backup-verify', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    if (!ticketId) return res.status(400).json({ error: 'Enter the Booking / Ticket ID.' });

    const ticket = await getTicketById(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found. Please check the Ticket ID.' });

    if (ticket.paymentStatus === 'VERIFIED' && ticket.status === 'CONFIRMED') {
      return res.json({ success: true, alreadyVerified: true, ticket });
    }

    const updated = await updateTicket(ticketId, {
      received_amount_rupees: Number(ticket.amountRupees) || 0,
      payment_status: 'VERIFIED',
      payment_verified_at: isoNow(),
      payment_rejected_at: null,
      payment_rejection_reason: null,
      status: 'CONFIRMED',
      used: false
    });

    if (!updated) return res.status(500).json({ error: 'Could not update the ticket.' });

    res.json({
      success: true,
      backup: true,
      message: 'Ticket manually verified by admin backup.',
      ticket: updated
    });
  } catch (err) {
    console.error('backup verify admin error:', err);
    res.status(500).json({ error: 'Could not backup-verify ticket.' });
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

app.post('/api/admin/cancel-booking/:ticketId', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId || '').trim().toUpperCase();
    const ticket = await getTicketById(ticketId);

    if (!ticket) return res.status(404).json({ error: 'Booking not found.' });

    // Cancel means remove the booking completely from the active ticket records.
    // This also removes its mobile/UTR/QR/payment record so the mobile can book again.
    const ok = await deleteTicketById(ticketId);
    if (!ok) return res.status(404).json({ error: 'Booking not found.' });

    res.json({
      success: true,
      cancelledTicketId: ticketId,
      message: 'Booking cancelled and all booking details removed.'
    });
  } catch (err) {
    console.error('admin cancel booking error:', err);
    res.status(500).json({ error: 'Could not cancel booking.' });
  }
});

app.get('/api/admin/ticket/:ticketId/pdf', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId || '').trim().toUpperCase();
    const ticket = await getTicketById(ticketId);
    if (!ticket) return res.status(404).send('Ticket not found.');
    const pdf = await makeTicketPdfBuffer(ticket);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="' + ticket.ticketId + '.pdf"');
    res.send(pdf);
  } catch (err) {
    console.error('admin ticket PDF error:', err);
    res.status(500).send('Could not generate ticket PDF.');
  }
});

app.delete('/api/admin/ticket/:ticketId', requireAdmin, async (req, res) => {
  try {
    const ticketId = String(req.params.ticketId || '').trim().toUpperCase();
    const ticket = await getTicketById(ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    const ok = await deleteTicketById(ticketId);
    if (!ok) return res.status(404).json({ error: 'Ticket not found.' });

    res.json({ success: true, deletedTicketId: ticketId });
  } catch (err) {
    console.error('admin delete ticket error:', err);
    res.status(500).json({ error: 'Could not delete ticket.' });
  }
});

async function qrPayload(ticket) {
  // Always generate the signature from the ticket ID on the server.
  // This keeps customer QR generation reliable even if the database
  // does not contain the legacy signature column/value.
  return JSON.stringify({
    ticketId: ticket.ticketId,
    sig: signTicket(ticket.ticketId)
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

    if (ticket.paymentStatus !== 'VERIFIED' || !['CONFIRMED', 'ENTERED', 'USED'].includes(ticket.status)) {
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
      ['CONFIRMED', 'ENTERED', 'USED'].includes(ticket.status);

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
      qrDataUrl: canShowQr ? awaitQr(ticket) : null,
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

    if (ticket.paymentStatus !== 'VERIFIED') {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'PAYMENT_NOT_VERIFIED_MANUAL'
      );
      return res.json({
        status: 'INVALID',
        message: 'Payment is not verified yet. Entry not allowed.',
        ticket: updated || ticket
      });
    }

    if (['ENTERED', 'USED'].includes(ticket.status) || ticket.used === true) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'ALREADY_USED_MANUAL'
      );
      return res.json({
        status: 'ALREADY_USED',
        message: 'ENTRY ALREADY USED — 2ND ENTRY NOT ALLOWED.',
        ticket: updated || ticket
      });
    }

    if (ticket.status !== 'CONFIRMED') {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'INVALID_TICKET_STATUS_MANUAL'
      );
      return res.json({
        status: 'INVALID',
        message: 'Ticket is not active for entry.',
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

    // First scan only verifies the ticket. Entry is committed only after
    // the staff explicitly presses ALLOW ENTRY.
    if (req.body.approveEntry !== true) {
      return res.json({
        status: 'VALID',
        message: 'Ticket verified. Customer details checked. Press ALLOW ENTRY to confirm entry.',
        ticket
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

    if (ticket.paymentStatus !== 'VERIFIED') {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'PAYMENT_NOT_VERIFIED'
      );
      return res.json({
        status: 'INVALID',
        message: 'Payment is not verified yet. Entry not allowed.',
        ticket: updated || ticket
      });
    }

    if (['ENTERED', 'USED'].includes(ticket.status) || ticket.used === true) {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'ALREADY_USED'
      );
      return res.json({
        status: 'ALREADY_USED',
        message: 'ENTRY ALREADY USED — 2ND ENTRY NOT ALLOWED.',
        ticket: updated || ticket
      });
    }

    if (ticket.status !== 'CONFIRMED') {
      const updated = await recordScanAttempt(
        ticketId, scanTime, staff, 'INVALID_TICKET_STATUS'
      );
      return res.json({
        status: 'INVALID',
        message: 'Ticket is not active for entry.',
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

    // First QR scan only verifies the ticket. Entry is committed only after
    // the staff explicitly presses ALLOW ENTRY.
    if (req.body.approveEntry !== true) {
      return res.json({
        status: 'VALID',
        message: 'Ticket verified. Customer details checked. Press ALLOW ENTRY to confirm entry.',
        ticket
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
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const expectedUser = process.env.ADMIN_USER || 'admin';

  if (!process.env.ADMIN_PASSWORD ||
      !safeCompare(username, expectedUser) ||
      !safeCompare(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({
      error: 'Invalid admin user ID or password.'
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

    const verifiedTickets = tickets.filter(t => t.paymentStatus === 'VERIFIED');
    const pendingUtr = tickets.filter(t => t.paymentStatus === 'PENDING' && t.utr).length;
    const receivedTotal = verifiedTickets.reduce((sum, t) => sum + (Number(t.receivedAmountRupees) || 0), 0);
    const used = tickets.filter(t => t.used).length;

    res.json({
      tickets,
      config: publicConfig(),
      summary: {
        paid: verifiedTickets.length,
        verifiedCount: verifiedTickets.length,
        receivedTotal: Math.round(receivedTotal * 100) / 100,
        pendingUtr,
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

app.get('/api/admin/ticket/:ticketId', requireAdmin, async (req, res) => {
  try {
    const ticket = await getTicketById(req.params.ticketId);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });

    const safeTicket = { ...ticket };
    delete safeTicket.signature;

    let qrDataUrl = null;
    if (ticket.paymentStatus === 'VERIFIED' && ['CONFIRMED', 'ENTERED', 'USED'].includes(ticket.status)) {
      qrDataUrl = await awaitQr(ticket);
    }

    res.json({ ticket: safeTicket, qrDataUrl, config: publicConfig() });
  } catch (err) {
    console.error('admin ticket view error:', err);
    res.status(500).json({ error: 'Could not load ticket.' });
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
      'Received Amount',
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
        t.receivedAmountRupees ?? '',
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

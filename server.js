require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const Razorpay = require('razorpay');
const QRCode = require('qrcode');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, 'data');
const TICKETS_FILE = path.join(DATA_DIR, 'tickets.json');
const CONFIG_FILE = path.join(DATA_DIR, 'event-config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SCANNER_DIR = path.join(__dirname, 'scanner');
const ADMIN_DIR = path.join(__dirname, 'admin');
const TZ = 'Asia/Kolkata';

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

if (!process.env.RZP_KEY_ID || !process.env.RZP_KEY_SECRET || process.env.RZP_KEY_ID.includes('REPLACE_WITH')) {
  console.warn('\n[WARNING] Add Razorpay credentials in server/.env before payments.\n');
}
if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.includes('ChangeThis')) {
  console.warn('\n[WARNING] Set a strong ADMIN_PASSWORD in server/.env before going live.\n');
}
if (!process.env.TICKET_SECRET || process.env.TICKET_SECRET.includes('Change_This')) {
  console.warn('\n[WARNING] Set a strong TICKET_SECRET in server/.env before going live.\n');
}

const razorpay = new Razorpay({ key_id: process.env.RZP_KEY_ID || '', key_secret: process.env.RZP_KEY_SECRET || '' });

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function writeJson(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, file); }
function readTickets() { return readJson(TICKETS_FILE, []); }
function writeTickets(tickets) { writeJson(TICKETS_FILE, tickets); }
function readConfig() { return { ...DEFAULT_CONFIG, ...readJson(CONFIG_FILE, {}), venueName: 'Aashirvadd Banquet Hall', venueAddress: 'Near Gai Ghat, Patna, Bihar', venueMapsUrl: 'https://maps.app.goo.gl/sHiKSQ9gZz1KkJwbA', instantTicketRelease: true, releaseOverride: true }; }
function writeConfig(config) { writeJson(CONFIG_FILE, { ...DEFAULT_CONFIG, ...config }); }
function cleanType(type) { return String(type || '').toUpperCase().trim(); }
function getTicketId() { return 'RR26-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function signTicket(ticketId) { return crypto.createHmac('sha256', process.env.TICKET_SECRET || 'change-me').update(ticketId).digest('hex'); }
function safeCompare(a, b) { const A = Buffer.from(String(a)); const B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }
function nowInIndia() { return new Date(new Date().toLocaleString('en-US', { timeZone: TZ })); }
function todayIndia() { const d = nowInIndia(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function isoNow() { return new Date().toISOString(); }
function formatIndia(iso) { if (!iso) return '-'; return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true }).format(new Date(iso)); }
function validReleaseDate(d) { return /^2026-10-(0[1-9]|[12]\d|3[01])$/.test(String(d || '')); }
function validReleaseTime(t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t || '')); }
function releaseReady(config) { return Boolean(String(config.venueName || '').trim() && String(config.venueAddress || '').trim()); }
function ticketReleased(config) { return true; }
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
  return crypto.createHmac('sha256', process.env.ADMIN_PASSWORD || 'missing-admin').update('rangilo-raas-admin-session-v1').digest('hex');
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach(part => { const i = part.indexOf('='); if (i > -1) out[part.slice(0,i).trim()] = decodeURIComponent(part.slice(i+1).trim()); });
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
function requireAdmin(req, res, next) { if (!isAdmin(req)) return res.status(401).json({ error: 'Admin authentication required.' }); next(); }
function getPeople(type, qty) { return Number(type.includes('COUPLE') ? 2 : 1) * qty; }
function validEventDate(date) { return readConfig().eventDates.includes(date); }
function setAdminCookie(res) { res.setHeader('Set-Cookie', `rr_admin=${encodeURIComponent(sessionToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`); }

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
    return res.status(403).json({ success:false, error:'Test Scan Mode is available only on the local computer.' });
  }
  const config = readConfig();
  config.testScanMode = req.body?.enabled === true;
  writeConfig(config);
  res.json({ success:true, testScanMode:config.testScanMode });
});

app.get('/api/local-test-scan-mode', (req, res) => {
  if (!isLoopbackRequest(req)) {
    return res.status(403).json({ success:false, error:'Local only.' });
  }
  res.json({ success:true, testScanMode:readConfig().testScanMode === true });
});


app.post('/api/create-order', async (req, res) => {
  try {
    const type = cleanType(req.body.type), qty = Number(req.body.qty), name = String(req.body.name || '').trim(), mobile = String(req.body.mobile || '').trim(), eventDate = String(req.body.eventDate || '').trim();
    if (!PRICES[type]) return res.status(400).json({ error: 'Invalid pass type.' });
    if (![1,2].includes(qty)) return res.status(400).json({ error: 'Quantity must be 1 or 2.' });
    if (!name) return res.status(400).json({ error: 'Name is required.' });
    if (!/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ error: 'Valid 10-digit mobile number is required.' });
    if (!validEventDate(eventDate)) return res.status(400).json({ error: 'Please select a valid event date.' });
    if (!process.env.RZP_KEY_ID || !process.env.RZP_KEY_SECRET || process.env.RZP_KEY_ID.includes('REPLACE_WITH')) return res.status(500).json({ error: 'Razorpay credentials are missing in server/.env.' });
    const fixed = Number(process.env.TEST_FIXED_AMOUNT_RUPEES || 0);
    const amountRupees = fixed > 0 ? fixed : PRICES[type] * qty;
    const order = await razorpay.orders.create({ amount: Math.round(amountRupees * 100), currency: 'INR', receipt: 'RR26-' + Date.now().toString(36).toUpperCase(), notes: { event: 'Rangilo Raas 2026', type, qty: String(qty), name, mobile, eventDate } });
    res.json({ keyId: process.env.RZP_KEY_ID, orderId: order.id, amount: order.amount, amountRupees, type, qty, people: getPeople(type, qty), name, mobile, eventDate });
  } catch (err) { console.error('create-order error:', err); res.status(500).json({ error: err?.error?.description || err.message || 'Could not create Razorpay order.' }); }
});

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: 'Missing Razorpay payment details.' });
    const expected = crypto.createHmac('sha256', process.env.RZP_KEY_SECRET || '').update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
    if (!safeCompare(expected, razorpay_signature)) return res.status(400).json({ error: 'Payment signature verification failed.' });
    const order = await razorpay.orders.fetch(razorpay_order_id), payment = await razorpay.payments.fetch(razorpay_payment_id);
    if (!order || order.id !== razorpay_order_id) return res.status(400).json({ error: 'Razorpay order could not be verified.' });
    if (payment.order_id !== razorpay_order_id) return res.status(400).json({ error: 'Payment does not belong to this order.' });
    if (payment.status !== 'captured') return res.status(400).json({ error: 'Payment is not captured yet.' });
    if (Number(payment.amount) !== Number(order.amount)) return res.status(400).json({ error: 'Payment amount does not match the order.' });
    const tickets = readTickets(), existing = tickets.find(t => t.paymentId === razorpay_payment_id);
    if (existing) return res.json({ success: true, ticket: existing, qrDataUrl: ticketReleased(readConfig()) ? awaitQr(existing) : null, config: publicConfig() });
    const notes = order.notes || {}, clean = cleanType(notes.type), q = Number(notes.qty), eventDate = String(notes.eventDate || ''), name = String(notes.name || '').trim(), mobile = String(notes.mobile || '').trim();
    if (!PRICES[clean] || ![1,2].includes(q) || !validEventDate(eventDate) || !name || !/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ error: 'Order details are invalid.' });
    const fixed = Number(process.env.TEST_FIXED_AMOUNT_RUPEES || 0), amountRupees = fixed > 0 ? fixed : PRICES[clean] * q, people = getPeople(clean, q), ticketId = getTicketId();
    const ticket = { ticketId, bookingId: ticketId, event: 'Rangilo Raas 2026', eventDate, eventDates: '16–17 October 2026', type: clean, qty: q, people, amountRupees, name, mobile, paymentId: razorpay_payment_id, orderId: razorpay_order_id, status: 'CONFIRMED', used: false, createdAt: isoNow(), scanHistory: [], signature: signTicket(ticketId) };
    tickets.push(ticket); writeTickets(tickets);
    const config = publicConfig();
    res.json({ success: true, ticket, qrDataUrl: config.ticketReleased ? awaitQr(ticket) : null, config });
  } catch (err) { console.error('verify-payment error:', err); res.status(500).json({ error: 'Could not verify payment.' }); }
});

async function qrPayload(ticket) {
  return JSON.stringify({ ticketId: ticket.ticketId, sig: ticket.signature });
}

async function awaitQr(ticket) {
  return QRCode.toDataURL(await qrPayload(ticket), { width: 320, margin: 2, errorCorrectionLevel: 'M' });
}

// Serve the QR as a real PNG file instead of embedding a large data URL in HTML.
// This avoids broken-image issues in browsers and keeps the QR directly usable by scanners.
app.get('/api/ticket/:ticketId/qr', async (req, res) => {
  try {
    const ticket = readTickets().find(t => t.ticketId === req.params.ticketId);
    if (!ticket) return res.status(404).send('Ticket not found.');
    const mobile = String(req.query.mobile || '').trim();
    if (!mobile || mobile !== ticket.mobile) return res.status(401).send('Unauthorized.');
    if (!ticketReleased(readConfig())) return res.status(403).send('Ticket QR is not released yet.');
    const png = await QRCode.toBuffer(await qrPayload(ticket), {
      type: 'png', width: 420, margin: 2, errorCorrectionLevel: 'M'
    });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.send(png);
  } catch (err) {
    console.error('QR image error:', err);
    res.status(500).send('Could not generate QR image.');
  }
});

app.get('/api/ticket/:ticketId', (req, res) => {
  const ticket = readTickets().find(t => t.ticketId === req.params.ticketId);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found.' });
  const mobile = String(req.query.mobile || '').trim();
  if (!mobile || mobile !== ticket.mobile) return res.status(401).json({ error: 'Booking ID and registered mobile number do not match.' });
  const config = publicConfig(), safeTicket = { ...ticket, signature: undefined };
  if (!config.ticketReleased) return res.json({ released: false, ticket: safeTicket, qrDataUrl: null, config });
  res.json({ released: true, ticket: safeTicket, qrDataUrl: ticket.signature ? awaitQr(ticket) : null, config });
});

app.post('/api/manual-scan', (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim().toUpperCase();
    const staff = String(req.body.staff || 'Gate Staff').trim().slice(0,80) || 'Gate Staff';
    if (!ticketId) return res.status(400).json({ status:'INVALID', message:'Ticket ID is required.' });
    const tickets = readTickets();
    const ticket = tickets.find(t => String(t.ticketId).toUpperCase() === ticketId);
    const scanTime = isoNow();
    if (!ticket) return res.status(404).json({ status:'INVALID', message:'Ticket ID not found.' });
    const config = publicConfig();
    ticket.scanHistory = Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [];
    if (!config.ticketReleased) {
      ticket.scanHistory.push({ at:scanTime, staff, result:'TICKET_NOT_RELEASED_MANUAL' });
      writeTickets(tickets);
      return res.json({ status:'INVALID', message:'Scanner is not active yet. Ticket/venue release is pending.', ticket });
    }
    if (!validEventDate(ticket.eventDate)) {
      ticket.scanHistory.push({ at:scanTime, staff, result:'INVALID_EVENT_DATE_MANUAL' });
      writeTickets(tickets);
      return res.json({ status:'INVALID', message:'Invalid event date on ticket.', ticket });
    }
    if (ticket.eventDate !== todayIndia() && !config.testScanMode) {
      ticket.scanHistory.push({ at:scanTime, staff, result:'WRONG_DATE_MANUAL' });
      writeTickets(tickets);
      return res.json({ status:'INVALID_DATE', message:`Ticket is valid only for ${ticket.eventDate}. Today is ${todayIndia()}.`, ticket });
    }
    if (ticket.used) {
      ticket.scanHistory.push({ at:scanTime, staff, result:'ALREADY_USED_MANUAL' });
      writeTickets(tickets);
      return res.json({ status:'ALREADY_USED', message:'ALREADY SCANNED — this ticket has already been used.', ticket });
    }
    ticket.used = true;
    ticket.status = 'USED';
    ticket.scannedAt = scanTime;
    ticket.scannedBy = staff;
    ticket.scanHistory.push({ at:scanTime, staff, result:'VALID_MANUAL' });
    writeTickets(tickets);
    res.json({ status:'VALID', message:'Entry approved. Ticket marked as used.', ticket });
  } catch (err) {
    console.error('manual scan error:', err);
    res.status(500).json({ status:'ERROR', message:'Manual verification error.' });
  }
});

app.post('/api/scan', (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || '').trim(), sig = String(req.body.sig || '').trim(), staff = String(req.body.staff || 'Gate Staff').trim().slice(0,80) || 'Gate Staff';
    if (!ticketId || !sig) return res.status(400).json({ status:'INVALID', message:'QR data incomplete.' });
    if (!safeCompare(sig, signTicket(ticketId))) return res.status(400).json({ status:'INVALID', message:'Invalid QR signature.' });
    const tickets = readTickets(), ticket = tickets.find(t => t.ticketId === ticketId);
    if (!ticket) return res.status(404).json({ status:'INVALID', message:'Ticket not found.' });
    const config = publicConfig(), scanTime = isoNow();
    ticket.scanHistory = Array.isArray(ticket.scanHistory) ? ticket.scanHistory : [];
    if (!config.ticketReleased) { ticket.scanHistory.push({ at:scanTime, staff, result:'TICKET_NOT_RELEASED' }); writeTickets(tickets); return res.json({ status:'INVALID', message:'Scanner is not active yet. Ticket/venue release is pending.', ticket }); }
    if (!validEventDate(ticket.eventDate)) { ticket.scanHistory.push({ at:scanTime, staff, result:'INVALID_EVENT_DATE' }); writeTickets(tickets); return res.json({ status:'INVALID', message:'Invalid event date on ticket.', ticket }); }
    if (ticket.eventDate !== todayIndia() && !config.testScanMode) { ticket.scanHistory.push({ at:scanTime, staff, result:'WRONG_DATE' }); writeTickets(tickets); return res.json({ status:'INVALID_DATE', message:`Ticket is valid only for ${ticket.eventDate}. Today is ${todayIndia()}.`, ticket }); }
    if (ticket.used) { ticket.scanHistory.push({ at:scanTime, staff, result:'ALREADY_USED' }); writeTickets(tickets); return res.json({ status:'ALREADY_USED', message:'ALREADY SCANNED — this ticket has already been used.', ticket }); }
    ticket.used = true; ticket.status = 'USED'; ticket.scannedAt = scanTime; ticket.scannedBy = staff; ticket.scanHistory.push({ at:scanTime, staff, result:'VALID' }); writeTickets(tickets);
    res.json({ status:'VALID', message:'Entry approved. Ticket marked as used.', ticket });
  } catch (err) { console.error('scan error:', err); res.status(500).json({ status:'ERROR', message:'Scanner error.' }); }
});

app.get('/api/admin/me', requireAdmin, (req,res) => res.json({ success:true, config:{...readConfig(), ...publicConfig()} }));
app.post('/api/admin/login', (req,res) => {
  const password = String(req.body.password || '');
  if (!process.env.ADMIN_PASSWORD || !safeCompare(password, process.env.ADMIN_PASSWORD)) return res.status(401).json({ error:'Invalid admin password.' });
  setAdminCookie(res); res.json({ success:true, config:{...readConfig(), ...publicConfig()} });
});
app.post('/api/admin/logout', requireAdmin, (req,res) => { res.setHeader('Set-Cookie','rr_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); res.json({success:true}); });
app.get('/api/admin/config', requireAdmin, (req,res) => res.json({ ...readConfig(), ...publicConfig() }));
app.post('/api/admin/config', requireAdmin, (req,res) => {
  const body = req.body || {}, config = readConfig();
  const eventDates = Array.isArray(body.eventDates) && body.eventDates.every(d => /^2026-10-(16|17)$/.test(d)) ? body.eventDates : config.eventDates;
  const next = {
    ...config,
    eventName: String(body.eventName ?? config.eventName).trim().slice(0,120) || config.eventName,
    eventTime: String(body.eventTime ?? config.eventTime).trim().slice(0,80) || config.eventTime,
    venueName: String(body.venueName ?? config.venueName).trim().slice(0,200),
    venueAddress: String(body.venueAddress ?? config.venueAddress).trim().slice(0,500),
    venueMapsUrl: String(body.venueMapsUrl ?? config.venueMapsUrl).trim().slice(0,1000),
    ticketReleaseDate: String(body.ticketReleaseDate ?? config.ticketReleaseDate).trim(),
    ticketReleaseTime: String(body.ticketReleaseTime ?? config.ticketReleaseTime).trim(),
    eventDates,
    instantTicketRelease: Boolean(body.instantTicketRelease ?? config.instantTicketRelease)
  };
  if (!validReleaseDate(next.ticketReleaseDate)) return res.status(400).json({ error:'Release date must be a valid October 2026 date.' });
  if (!validReleaseTime(next.ticketReleaseTime)) return res.status(400).json({ error:'Release time must be in HH:MM format.' });
  writeConfig(next);
  res.json({ success:true, config:{...next,...publicConfig()} });
});
app.post('/api/admin/release-now', requireAdmin, (req,res) => {
  const config = readConfig();
  if (!releaseReady(config)) return res.status(400).json({ error:'Add venue name and full address before releasing tickets.' });
  config.releaseOverride = true;
  config.lastReleasedAt = isoNow();
  writeConfig(config);
  res.json({ success:true, message:'All eligible paid tickets are now released.', config:{...config,...publicConfig()} });
});
app.post('/api/admin/test-release', requireAdmin, (req,res) => {
  const config = readConfig();
  config.releaseOverride = true;
  config.lastReleasedAt = isoNow();
  writeConfig(config);
  res.json({ success:true, message:'TEST RELEASE activated. Tickets, venue and scanner are now active.', config:{...config,...publicConfig()} });
});
app.post('/api/admin/revoke-release', requireAdmin, (req,res) => {
  const config = readConfig();
  config.releaseOverride = false;
  writeConfig(config);
  res.json({ success:true, message:'Release override removed. Scheduled release rules are active again.', config:{...config,...publicConfig()} });
});
app.get('/api/admin/tickets', requireAdmin, (req,res) => {
  const tickets = readTickets().map(t => ({...t, signature:undefined}));
  const scans = tickets.reduce((n,t)=>n+(Array.isArray(t.scanHistory)?t.scanHistory.length:0),0);
  const used = tickets.filter(t=>t.used).length;
  res.json({ tickets, config:publicConfig(), summary:{paid:tickets.length,used,unused:tickets.length-used,scanAttempts:scans} });
});

app.get('/api/admin/export.csv', requireAdmin, (req,res) => {
  const esc = v => '"'+String(v ?? '').replace(/"/g,'""')+'"';
  const rows = [['Ticket ID','Name','Mobile','Event Date','Pass','Qty','People','Amount','Status','First Entry (IST)','Scans']];
  for (const t of readTickets()) rows.push([t.ticketId,t.name,t.mobile,t.eventDate,t.type,t.qty,t.people,t.amountRupees,t.status,formatIndia(t.scannedAt),(t.scanHistory||[]).length]);
  res.setHeader('Content-Type','text/csv; charset=utf-8'); res.setHeader('Content-Disposition','attachment; filename="rangilo-raas-bookings.csv"'); res.send(rows.map(r=>r.map(esc).join(',')).join('\n'));
});

app.get('/health', (req,res)=>res.json({ok:true,time:isoNow()}));
app.get(/.*/, (req,res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
const HOST = process.env.HOST || '0.0.0.0';
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3443);
const CERT_DIR = path.join(__dirname, 'certs');
const KEY_FILE = path.join(CERT_DIR, 'server-key.pem');
const CERT_FILE = path.join(CERT_DIR, 'server-cert.pem');

app.listen(PORT, HOST, () => {
  console.log(`\nRangilo Raas HTTP server running: http://localhost:${PORT}`);
  console.log(`LAN HTTP: http://<LAPTOP-IP>:${PORT}/scanner/`);
  console.log(`Admin: http://localhost:${PORT}/admin/`);
  console.log(`Test fixed amount: ₹${Number(process.env.TEST_FIXED_AMOUNT_RUPEES || 0) || 'normal ticket price'}`);
  console.log(`Listening on ${HOST}:${PORT}`);
});

// HTTPS is required by mobile browsers for camera access (getUserMedia).
// A local certificate is bundled for the current LAN IP used during testing.
try {
  if (fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE)) {
    https.createServer({ key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) }, app)
      .listen(HTTPS_PORT, HOST, () => {
        console.log(`HTTPS camera scanner: https://10.103.1.206:${HTTPS_PORT}/scanner/`);
        console.log(`HTTPS listening on ${HOST}:${HTTPS_PORT}`);
      });
  } else {
    console.warn('[WARNING] HTTPS certificate files missing. Mobile camera requires HTTPS.');
  }
} catch (e) {
  console.error('[WARNING] Could not start HTTPS server:', e.message);
}

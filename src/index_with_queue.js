/**
 * WhatsApp Gateway — Baileys Multi-Session Edition
 * --------------------------------------------------
 * Supports multiple simultaneous WhatsApp sessions (one per company/tenant).
 * Each session has its own auth_info subfolder, socket, QR, and state.
 * No Chromium needed — pure WebSocket via @whiskeysockets/baileys.
 *
 * Compatible with: Node.js 18+, cPanel, Hostinger shared hosting, any VPS.
 */

import 'dotenv/config';

import express from 'express';
import session from 'express-session';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import multer from 'multer';
import qrcodeImage from 'qrcode';
import logger from './logger.js';
import { messageQueue } from './queue.js';
import { fileURLToPath } from 'url';

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    downloadMediaMessage,
    makeCacheableSignalKeyStore,
    Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logFile = path.join(__dirname, 'gateway-errors.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

function logError(type, err) {
    const msg = `[${new Date().toISOString()}] ${type}: ${err.stack || err}\n`;
    console.error(msg);       // still shows in terminal if you have SSH
    logStream.write(msg);     // persists to file
}

process.on('unhandledRejection', err => logError('Unhandled Rejection', err));
process.on('uncaughtException', err => logError('Uncaught Exception', err));

// ── Express setup ─────────────────────────────────────────────────────────────
const app = express();

app.set('trust proxy', 1);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session ───────────────────────────────────────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';

app.use(session({
    secret: process.env.GATEWAY_SESSION_SECRET || 'whatsapp-crm-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
    },
}));

// ── Paths & credentials ───────────────────────────────────────────────────────
const publicDir = path.join(process.cwd(), 'src', 'public');
const AUTH_BASE = process.env.AUTH_DIR || path.join(process.cwd(), 'src', 'auth_info');
const uiUsername = process.env.GATEWAY_UI_USER || 'admin';
const uiPassword = process.env.GATEWAY_UI_PASSWORD || 'password';
const CRM_MAX_MEDIA_BYTES = Number(process.env.CRM_MAX_MEDIA_BYTES || 4 * 1024 * 1024);
const CRM_MEDIA_UPLOAD_URL = stripTrailingSlash(process.env.CRM_MEDIA_UPLOAD_URL || '');
const CRM_MEDIA_UPLOAD_TIMEOUT_MS = Number(process.env.CRM_MEDIA_UPLOAD_TIMEOUT_MS || 60000);

let cachedBaileysVersion = null;

// ── Multi-session state ───────────────────────────────────────────────────────
const sessions = new Map();

function createSessionState(sessionId) {
    return {
        id: sessionId,
        socket: null,
        isReady: false,
        status: 'disconnected',
        qrCodeData: null,
        connectedPhone: null,
        reconnectTimer: null,
        reconnectCount: 0,
        qrExpiredCount: 0,
        processedMessageIds: new Set(),
        processedMessageIdQueue: [],
        generation: 0,
        lockInterval: null, // Used for heartbeat lock
    };
}

function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        const session = createSessionState(sessionId);
        
        // Load persistent data into RAM on boot
        const savedMeta = loadSessionMetadata(sessionId);
        if (savedMeta) {
            session.status = savedMeta.status === 'connected' ? 'connecting' : savedMeta.status;
            session.connectedPhone = savedMeta.phone;
        }
        
        sessions.set(sessionId, session);
    }
    return sessions.get(sessionId);
}

function recordProcessedMessageId(session, messageId) {
    if (!messageId || session.processedMessageIds.has(messageId)) return false;
    session.processedMessageIds.add(messageId);
    session.processedMessageIdQueue.push(messageId);
    if (session.processedMessageIdQueue.length > 500) {
        session.processedMessageIds.delete(session.processedMessageIdQueue.shift());
    }
    return true;
}

// ── Auth dir & Metadata helpers ───────────────────────────────────────────────
function getAuthDir(sessionId) {
    return path.join(AUTH_BASE, sessionId);
}

function clearAuthState(sessionId) {
    const dir = getAuthDir(sessionId);
    try {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(dir, { recursive: true });
        logger.info(`[${sessionId}] Auth cleared — fresh QR will be generated.`);
    } catch (err) {
        logger.error(`[${sessionId}] clearAuthState error:`, err.message);
    }
}

function saveSessionMetadata(session) {
    const dir = getAuthDir(session.id);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const metadataFile = path.join(dir, 'metadata.json');
    const dataToSave = {
        id: session.id,
        status: session.status,
        phone: session.connectedPhone,
        lastUpdated: new Date().toISOString()
    };

    try { fs.writeFileSync(metadataFile, JSON.stringify(dataToSave, null, 2)); } 
    catch (err) { logger.error(`[${session.id}] Failed to save metadata: ${err.message}`); }
}

function loadSessionMetadata(sessionId) {
    const metadataFile = path.join(getAuthDir(sessionId), 'metadata.json');
    if (!fs.existsSync(metadataFile)) return null;
    try { return JSON.parse(fs.readFileSync(metadataFile, 'utf8')); } 
    catch (err) { return null; }
}

// ── Heartbeat Lock System (Hostinger Clone Fix) ───────────────────────────────
const LOCK_DIR = path.join(process.cwd(), 'locks');
if (!fs.existsSync(LOCK_DIR)) fs.mkdirSync(LOCK_DIR, { recursive: true });

function isSessionLocked(sessionId) {
    const lockFile = path.join(LOCK_DIR, `${sessionId}.lock`);
    if (!fs.existsSync(lockFile)) return false;

    try {
        const stats = fs.statSync(lockFile);
        const ageInMs = Date.now() - stats.mtimeMs;
        return ageInMs < 30000; // Locked if touched in last 30s
    } catch { return false; }
}

function startLockHeartbeat(session) {
    const lockFile = path.join(LOCK_DIR, `${session.id}.lock`);
    fs.writeFileSync(lockFile, `Locked by PID: ${process.pid}`);
    
    session.lockInterval = setInterval(() => {
        try {
            const now = new Date();
            fs.utimesSync(lockFile, now, now);
        } catch (err) {}
    }, 10000);
}

function clearLockHeartbeat(session) {
    if (session.lockInterval) {
        clearInterval(session.lockInterval);
        session.lockInterval = null;
    }
    const lockFile = path.join(LOCK_DIR, `${session.id}.lock`);
    try { if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile); } catch {}
}


// ── Auth middleware ───────────────────────────────────────────────────────────
const ensureUIAuth = (req, res, next) => {
    if (req.session?.loggedIn) return next();
    if (req.headers.accept?.includes('text/html')) return res.redirect('/login');
    return res.status(401).json({ error: 'Unauthorized' });
};

const gatewayAuth = (req, res, next) => {
    if (req.headers['x-gateway-secret'] !== process.env.GATEWAY_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
};

// ── UI Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => req.session?.loggedIn ? res.redirect('/ui') : res.sendFile(path.join(publicDir, 'index.html')));
app.get('/login', (req, res) => req.session?.loggedIn ? res.redirect('/ui') : res.sendFile(path.join(publicDir, 'index.html')));

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === uiUsername && password === uiPassword) {
        req.session.loggedIn = true;
        logger.info(`UI login by ${username}`);
        return res.json({ success: true });
    }
    logger.warn(`UI login failed for ${username}`);
    return res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/ui', ensureUIAuth, (req, res) => res.sendFile(path.join(publicDir, 'ui.html')));
app.use(express.static(publicDir));

// ── Multer — preserve original filename + extension ───────────────────────────
const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = 'temp_uploads/';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${Date.now()}_${safe}`);
    },
});
const upload = multer({ storage: multerStorage });

// ── Helpers ───────────────────────────────────────────────────────────────────
function sanitisePhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    let normalized = '';
    if (digits.length === 10) normalized = `91${digits}`;
    else if (digits.length === 11 && digits.startsWith('0')) normalized = `91${digits.slice(1)}`;
    else if (digits.length === 12 && digits.startsWith('91')) normalized = digits;
    else if (digits.length === 13 && digits.startsWith('091')) normalized = digits.slice(1);
    else if (digits.length === 14 && digits.startsWith('0091')) normalized = digits.slice(2);

    if (!normalized || !/^[6-9]\d{9}$/.test(normalized.slice(2))) return '';
    return normalized;
}
function stripTrailingSlash(url) { return url ? url.replace(/\/+$/, '') : url; }

async function uploadMediaToCRM({ sessionId, fromPhone, filename, mimetype, buffer, messageId, mediaType }) {
    if (!CRM_MEDIA_UPLOAD_URL) return null;
    try {
        const headers = {
            'X-Gateway-Secret': process.env.GATEWAY_SECRET, 'X-Session-Id': sessionId, 'X-From-Phone': fromPhone,
            'X-Message-Id': messageId, 'X-Media-Type': mediaType, 'X-File-Name': filename,
            'Content-Type': mimetype, 'Content-Length': buffer.length,
        };
        const response = await axios.post(CRM_MEDIA_UPLOAD_URL, buffer, { headers, maxBodyLength: Infinity, maxContentLength: Infinity, timeout: CRM_MEDIA_UPLOAD_TIMEOUT_MS });
        return response?.data || null;
    } catch (err) {
        console.log(err);
        logger.error(`[${sessionId}] Media upload to CRM failed:`, err.message); return null;
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mimeToExt(mime) {
    const m = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf',
        'video/mp4': 'mp4', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
        'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
        'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
    };
    return m[mime] || 'bin';
}

function guessMime(filePath) {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const m = {
        jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
        mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
        doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        txt: 'text/plain', csv: 'text/csv', zip: 'application/zip',
    };
    return m[ext] || 'application/octet-stream';
}

function extractText(msg) {
    const m = msg.message; if (!m) return '';
    return (m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption ||
        m.documentMessage?.caption || m.buttonsResponseMessage?.selectedDisplayText || m.templateButtonReplyMessage?.selectedDisplayText || m.listResponseMessage?.title || '');
}

function getMessageType(msg) {
    const m = msg.message; if (!m) return 'text';
    if (m.imageMessage) return 'image'; if (m.documentMessage) return 'document'; if (m.videoMessage) return 'video';
    if (m.audioMessage) return 'audio'; if (m.stickerMessage) return 'sticker'; if (m.locationMessage) return 'location';
    if (m.contactMessage) return 'contact'; return 'text';
}

function isValidInbound(msg) {
    const jid = msg.key.remoteJid ?? '';
    if (msg.key.fromMe) return false;
    if (isJidBroadcast(jid) || isJidGroup(jid) || isJidNewsletter?.(jid)) return false;
    if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@c.us')) return true;
    return false;
}

// ── CRM webhook notifier ──────────────────────────────────────────────────────
async function notifyCRM(payload, retries = 3) {
    const base = stripTrailingSlash(process.env.CRM_URL);
    if (!base) { logger.error('CRM_URL not set in .env'); return; }

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await axios.post(`${base}/api/gateway/webhook`, payload, {
                headers: { 'X-Gateway-Secret': process.env.GATEWAY_SECRET, 'Content-Type': 'application/json' }, timeout: 10000,
            });
            return;
        } catch (err) {
            const status = err?.response?.status;
            logger.error(`CRM notify failed (attempt ${attempt}/${retries}): HTTP ${status ?? 'N/A'} — ${err?.message}`);
            if (attempt < retries && status !== 401) await sleep(2000 * attempt);
        }
    }
}

// ── Baileys connection (per session) ──────────────────────────────────────────
async function connectWhatsApp(sessionId) {
    // 1. THE STOP SIGN: Check if another Hostinger process is already running this
    if (isSessionLocked(sessionId)) {
        logger.warn(`[${sessionId}] ABORT: Another background worker owns this session. Stepping back.`);
        return null; 
    }

    const session = getOrCreateSession(sessionId);

    if (session.socket) {
        logger.warn(`[${sessionId}] Closing old socket before reconnecting.`);
        try { session.socket.end?.(); } catch (e) { }
        session.socket = null;
        session.isReady = false;
        session.status = 'disconnected';
        clearLockHeartbeat(session);
    }

    if (session.reconnectTimer) {
        clearTimeout(session.reconnectTimer);
        session.reconnectTimer = null;
    }

    // 2. CLAIM THE LOCK
    startLockHeartbeat(session);

    logger.info(`[${sessionId}] Connecting to WhatsApp via Baileys...`);
    session.status = 'connecting';
    saveSessionMetadata(session); // Save "connecting" status to UI

    const authDir = getAuthDir(sessionId);
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    if (!cachedBaileysVersion) {
        try {
            const result = await fetchLatestBaileysVersion();
            cachedBaileysVersion = result.version;
            logger.info(`Baileys protocol version: ${cachedBaileysVersion.join('.')}`);
        } catch {
            cachedBaileysVersion = [2, 3000, 1023498599];
        }
    }

    const msgRetryCounterCache = new Map();

    const silentLogger = {
        level:  'silent',
        trace:  () => {}, debug:  () => {}, info:   () => {}, warn:   () => {}, error:  () => {}, fatal:  () => {},
        child:  function() { return silentLogger; }, 
    };

    const sock = makeWASocket({
        version: cachedBaileysVersion,
        auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, silentLogger) },
        logger: silentLogger,
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000, 
        retryRequestDelayMs: 2000,
        maxMsgRetryCount: 10,
        msgRetryCounterCache,
        generateHighQualityLinkPreview: false,
        getMessage: async (key) => undefined,
    });

    session.socket = sock;
    session.generation += 1;
    const myGen = session.generation;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        if (myGen !== session.generation) return;

        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            session.qrCodeData = await qrcodeImage.toDataURL(qr);
            session.status = 'qr_ready';
            session.isReady = false;
            saveSessionMetadata(session);
            logger.info(`[${sessionId}] QR code generated — waiting for scan.`);
            await notifyCRM({ event: 'qr_generated', session_id: sessionId, message: 'QR Code generated' });
        }

        if (connection === 'open') {
            session.isReady = true;
            session.status = 'connected';
            session.qrCodeData = null;
            session.reconnectCount = 0;
            session.qrExpiredCount = 0;
            session.connectedPhone = sock.user?.id?.split(':')[0] ?? sock.user?.id ?? null;
            
            saveSessionMetadata(session); // Sync to UI

            logger.info(`[${sessionId}] Connected! Phone: ${session.connectedPhone}`);
            await notifyCRM({ event: 'session_ready', session_id: sessionId, phone: session.connectedPhone });
        }

        if (connection === 'close') {
            const boom = lastDisconnect?.error instanceof Boom ? lastDisconnect.error : null;
            const statusCode = boom?.output?.statusCode ?? 0;
            const reason = Object.keys(DisconnectReason).find(k => DisconnectReason[k] === statusCode) ?? `code_${statusCode}`;

            session.isReady = false;
            session.status = 'disconnected';
            session.socket = null;
            
            // Release lock so we can safely reconnect
            clearLockHeartbeat(session);
            saveSessionMetadata(session); // Sync to UI

            logger.warn(`[${sessionId}] Closed. Reason: ${reason} (${statusCode})`);
            await notifyCRM({ event: 'session_disconnected', session_id: sessionId, reason });

            const hardStop = [DisconnectReason.loggedOut, DisconnectReason.multideviceMismatch, 401, 403].includes(statusCode);
            const isConnectionReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;
            const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
            const isTimeoutOrLost = statusCode === DisconnectReason.connectionLost || statusCode === DisconnectReason.timedOut || statusCode === 408;

            if (hardStop) {
                logger.warn(`[${sessionId}] Hard disconnect — clearing credentials.`);
                clearAuthState(sessionId);
                session.reconnectCount = 0;
                session.qrExpiredCount = 0;
                session.reconnectTimer = setTimeout(() => connectWhatsApp(sessionId), 3000);

            } else if (isConnectionReplaced) {
                logger.warn(`[${sessionId}] Connection replaced by another login (440). Pausing reconnect for 2 mins.`);
                session.reconnectCount = 0;
                session.reconnectTimer = setTimeout(() => connectWhatsApp(sessionId), 2 * 60 * 1000);

            } else if (isRestartRequired) {
                logger.info(`[${sessionId}] Stream restart required (515). Reconnecting immediately...`);
                session.reconnectTimer = setTimeout(() => connectWhatsApp(sessionId), 2000);

            } else {
                if (session.status === 'qr_ready' && isTimeoutOrLost) {
                    session.qrExpiredCount++;
                    logger.info(`[${sessionId}] QR expired (${session.qrExpiredCount}/5).`);
                    if (session.qrExpiredCount >= 5) {
                        logger.warn(`[${sessionId}] 5 unscanned QRs in a row — pausing for 5 minutes.`);
                        session.qrExpiredCount = 0;
                        session.reconnectTimer = setTimeout(() => connectWhatsApp(sessionId), 5 * 60 * 1000);
                    } else {
                        session.reconnectTimer = setTimeout(() => connectWhatsApp(sessionId), 3000);
                    }
                } else {
                    const delay = Math.min(5000 * Math.pow(2, session.reconnectCount), 60000);
                    session.reconnectCount++;
                    logger.info(`[${sessionId}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${session.reconnectCount})...`);
                    session.reconnectTimer = setTimeout(() => connectWhatsApp(sessionId), delay);
                }
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        if (myGen !== session.generation) return;
        if (type !== 'notify' && type !== 'append') return;

        const sixtySecondsAgo = Math.floor(Date.now() / 1000) - 60;

        for (const msg of msgs) {
            try {
                if (!isValidInbound(msg)) continue;

                if (type === 'append') {
                    const msgTime = msg.messageTimestamp ? (typeof msg.messageTimestamp === 'object' ? msg.messageTimestamp.low : Number(msg.messageTimestamp)) : 0;
                    if (msgTime < sixtySecondsAgo) continue;
                }

                const jid = msg.key.remoteJid;
                const rawFromPhone = msg.key.senderPn || msg.key.participantPn || jid;
                const fromPhone = sanitisePhone(rawFromPhone);
                if (!fromPhone) continue;
                
                const messageId = msg.key.id;
                const body = extractText(msg);
                const msgType = getMessageType(msg);

                const mediaTypeMap = { imageMessage: 'image', documentMessage: 'document', videoMessage: 'video', audioMessage: 'audio', stickerMessage: 'sticker' };
                const mediaKey = Object.keys(mediaTypeMap).find(k => msg.message?.[k]);

                if (!body && !mediaKey) continue;
                if (!recordProcessedMessageId(session, messageId)) continue;

                logger.info(`[${sessionId}] Inbound from ${fromPhone}: "${body?.substring(0, 80)}"`);

                const payload = {
                    from: fromPhone, body: body || '', type: msgType, timestamp: msg.messageTimestamp, message_id: messageId,
                    is_forwarded: !!(msg.message?.extendedTextMessage?.contextInfo?.isForwarded),
                };

                if (mediaKey) {
                    try {
                        const mediaData = msg.message[mediaKey];
                        const mime = mediaData.mimetype || 'application/octet-stream';
                        const filename = mediaData.fileName || `attachment_${Date.now()}.${mimeToExt(mime)}`;
                        payload.has_media = true;
                        payload.media = { mimetype: mime, filename };

                        const buffer = await downloadMediaMessage(
                            msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage.bind(sock) }
                        );

                        const bufferSize = buffer.length;
                        payload.media.size_bytes = bufferSize;

                        let uploadResult = null;
                        if (bufferSize > CRM_MAX_MEDIA_BYTES && CRM_MEDIA_UPLOAD_URL) {
                            uploadResult = await uploadMediaToCRM({ sessionId, fromPhone, filename, mimetype: mime, buffer, messageId, mediaType: mediaTypeMap[mediaKey] });
                        }

                        if (uploadResult?.media_url || uploadResult?.media_id || uploadResult?.file_id || uploadResult?.id) {
                            payload.media.crm_media_url = uploadResult.media_url;
                            payload.media.crm_file_id = uploadResult.media_id || uploadResult.file_id || uploadResult.id;
                            payload.media.note = 'media stored in CRM';
                        } else if (bufferSize <= CRM_MAX_MEDIA_BYTES) {
                            payload.media.data = buffer.toString('base64');
                        } else {
                            payload.media.note = 'media omitted due to size limit or upload failure';
                        }
                    } catch (mediaErr) {
                        logger.error(`[${sessionId}] Media download failed:`, mediaErr.message);
                    }
                }

                await notifyCRM({ event: 'incoming_message', session_id: sessionId, data: payload });
            } catch (err) {
                logger.error(`[${sessionId}] Message processing error:`, err.message);
            }
        }
    });

    sock.ev.on('message-receipt.update', async (updates) => {
        if (myGen !== session.generation) return;
        for (const { key, receipt } of updates) {
            if (!key.fromMe) continue;
            const ack = receipt.readTimestamp ? 3 : receipt.receiptTimestamp ? 2 : 1;
            await notifyCRM({ event: 'message_ack', session_id: sessionId, data: { message_id: key.id, ack } });
        }
    });

    return sock;
}

// ── Queue processor ───────────────────────────────────────────────────────────
messageQueue.process(1, async (job) => {
    const { sessionId, to, message, media_path, media_mimetype, media_filename, delay_ms } = job.data;
    if (delay_ms) await sleep(delay_ms);

    const session = sessions.get(sessionId);
    if (!session?.isReady || !session?.socket) throw new Error(`Session ${sessionId} not ready — will retry`);

    const phone = sanitisePhone(to);
    const chatId = `${phone}@s.whatsapp.net`;

    if (media_path) {
        if (!fs.existsSync(media_path)) throw new Error(`Media file missing: ${media_path}`);
        const mimeType = media_mimetype || guessMime(media_path);
        const filename = media_filename || path.basename(media_path);
        const buffer = fs.readFileSync(media_path);

        logger.info(`[${sessionId}] Sending media "${filename}" (${mimeType}) → ${chatId}`);

        let content;
        if (mimeType.startsWith('image/')) content = { image: buffer, mimetype: mimeType, caption: message || '', fileName: filename };
        else if (mimeType.startsWith('video/')) content = { video: buffer, mimetype: mimeType, caption: message || '', fileName: filename };
        else if (mimeType.startsWith('audio/')) content = { audio: buffer, mimetype: mimeType, ptt: false };
        else content = { document: buffer, mimetype: mimeType, caption: message || '', fileName: filename };

        await session.socket.sendMessage(chatId, content);
        try { fs.unlinkSync(media_path); } catch { }
        logger.info(`[${sessionId}] ✓ Media "${filename}" delivered to ${chatId}`);
    } else {
        if (!message?.trim()) throw new Error('Empty text body — skipped');
        await session.socket.sendMessage(chatId, { text: message });
        logger.info(`[${sessionId}] ✓ Text delivered to ${chatId}`);
    }

    return { success: true, sessionId, to: phone, timestamp: Date.now() };
});

messageQueue.on('failed', (job, err) => {
    if (job.data?.media_path && fs.existsSync(job.data.media_path)) {
        try { fs.unlinkSync(job.data.media_path); } catch { }
    }
    notifyCRM({ event: 'message_failed', data: { job_id: job.id, error: err.message, ...job.data } });
});

messageQueue.on('completed', (job, result) => {
    notifyCRM({ event: 'message_sent', data: { job_id: job.id, ...result } });
});

// ── API routes (called by Laravel CRM) ───────────────────────────────────────
function buildSessionStatus(session) {
    return { session_id: session.id, status: session.status, is_ready: session.isReady, qr: session.qrCodeData, phone: session.connectedPhone };
}

app.get('/status', gatewayAuth, (req, res) => {
    const all = {};
    for (const [id, s] of sessions) all[id] = buildSessionStatus(s);
    res.json(all);
});

app.get('/status/:sessionId', gatewayAuth, (req, res) => {
    const s = sessions.get(req.params.sessionId);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    res.json(buildSessionStatus(s));
});

app.get('/queue/stats', gatewayAuth, async (req, res) => {
    res.json({
        waiting: await messageQueue.getWaitingCount(), active: await messageQueue.getActiveCount(),
        completed: await messageQueue.getCompletedCount(), failed: await messageQueue.getFailedCount(),
    });
});

app.post('/send', gatewayAuth, async (req, res) => {
    const { sessionId, to, message, priority = 0 } = req.body;
    if (!sessionId || !to || !message) return res.status(400).json({ error: 'sessionId, to, and message are required' });

    const session = sessions.get(sessionId);
    if (!session?.isReady) return res.status(503).json({ error: `Session ${sessionId} not connected` });

    const phone = sanitisePhone(to);
    if (phone.length < 7) return res.status(400).json({ error: `Invalid phone: ${to}` });

    const delay_ms = 3000 + Math.floor(Math.random() * 9000);
    const job = await messageQueue.add({ sessionId, to: phone, message, delay_ms }, { priority, attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    res.json({ success: true, job_id: job.id, delay_ms });
});

app.post('/send-media', gatewayAuth, upload.single('file'), async (req, res) => {
    const { sessionId, to, caption, original_filename, mime_type } = req.body;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!sessionId) { try { fs.unlinkSync(req.file.path); } catch { } return res.status(400).json({ error: 'sessionId is required' }); }

    const session = sessions.get(sessionId);
    if (!session?.isReady) { try { fs.unlinkSync(req.file.path); } catch { } return res.status(503).json({ error: `Session ${sessionId} not connected` }); }

    const phone = sanitisePhone(to);
    if (phone.length < 7) { try { fs.unlinkSync(req.file.path); } catch { } return res.status(400).json({ error: `Invalid phone: ${to}` }); }

    const job = await messageQueue.add({
        sessionId, to: phone, message: caption || '', media_path: req.file.path,
        media_mimetype: mime_type || req.file.mimetype || 'application/octet-stream',
        media_filename: original_filename || req.file.originalname || path.basename(req.file.path),
        delay_ms: 2000 + Math.floor(Math.random() * 5000),
    }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

    res.json({ success: true, job_id: job.id });
});

app.post('/logout', gatewayAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    try {
        if (session.socket) { await session.socket.logout().catch(() => {}); session.socket = null; }
        session.isReady = false; session.status = 'disconnected'; session.qrCodeData = null; session.connectedPhone = null;
        clearLockHeartbeat(session);
        clearAuthState(sessionId);
        saveSessionMetadata(session);
        setTimeout(() => connectWhatsApp(sessionId).catch(() => {}), 2000);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/session/create', gatewayAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return res.status(400).json({ error: 'sessionId must be alphanumeric with _ or - only' });

    if (sessions.has(sessionId)) return res.json({ success: true, sessionId, alreadyExists: true, ...buildSessionStatus(sessions.get(sessionId)) });

    getOrCreateSession(sessionId);
    try { await connectWhatsApp(sessionId); res.json({ success: true, sessionId }); } 
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/session/:sessionId', gatewayAuth, async (req, res) => {
    const { sessionId } = req.params;
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.socket) { await session.socket.logout().catch(() => { }); session.socket = null; }
    clearLockHeartbeat(session);
    clearAuthState(sessionId);
    
    // Completely remove session and its metadata file
    const metaFile = path.join(getAuthDir(sessionId), 'metadata.json');
    try { if (fs.existsSync(metaFile)) fs.unlinkSync(metaFile); } catch {}
    sessions.delete(sessionId);
    
    res.json({ success: true });
});

// ── UI routes (browser dashboard) ────────────────────────────────────────────
app.get('/ui/status', ensureUIAuth, (req, res) => {
    const all = [];
    for (const [, s] of sessions) all.push(buildSessionStatus(s));
    res.json({ sessions: all });
});

app.post('/ui/logout', ensureUIAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    const session = sessions.get(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    try { if (session.socket) { await session.socket.logout().catch(() => {}); session.socket = null; } } catch (e) {}

    session.isReady = false; session.status = 'disconnected'; session.qrCodeData = null; session.connectedPhone = null;
    clearLockHeartbeat(session);
    clearAuthState(sessionId);
    saveSessionMetadata(session);
    setTimeout(() => connectWhatsApp(sessionId).catch(() => {}), 2000);
    res.json({ success: true });
});

app.post('/ui/session-destroy', ensureUIAuth, (req, res) => {
    req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ success: true }); });
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);

app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`=== WhatsApp Gateway (Baileys Multi-Session) started ===`);
    logger.info(`Port        : ${PORT}`);
    logger.info(`Environment : ${process.env.NODE_ENV || 'development'}`);
    logger.info(`Cookies     : secure=${isProduction}, sameSite=${isProduction ? 'none' : 'lax'}`);
    logger.info(`Auth base   : ${AUTH_BASE}`);
    logger.info('=======================================================');

    if (!fs.existsSync(AUTH_BASE)) fs.mkdirSync(AUTH_BASE, { recursive: true });
    const savedSessions = fs.readdirSync(AUTH_BASE).filter(f => fs.statSync(path.join(AUTH_BASE, f)).isDirectory());

    if (savedSessions.length > 0) {
        logger.info(`Restoring ${savedSessions.length} saved session(s)`);
        for (const sessionId of savedSessions) {
            // Check if it's already locked (in case of Hostinger running dual startup commands)
            if (!isSessionLocked(sessionId)) {
                await connectWhatsApp(sessionId).catch(() => {});
            } else {
                logger.warn(`[${sessionId}] Skipped boot restore: Another worker already has the lock.`);
            }
        }
    }
});
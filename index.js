/**
 * ============================================
 * BAILEYS SERVER v3.6.0
 * ============================================
 * SEM HISTÓRICO - Apenas mensagens novas em tempo real
 * - Desabilita sincronização de histórico completamente
 * - Busca groupMetadata para nomes corretos de grupos
 * - Extrai sender_phone corretamente do participant
 * - Cache de metadados para performance
 * Para WhatsApp CRM - Lovable
 * ============================================
 */

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Dynamic imports for ESM modules
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, downloadMediaMessage, Browsers;
let QRCode, pino, mime, supabase;

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Store sessions in memory
const sessions = new Map();

// Cache for group metadata (persists across messages)
const groupMetadataCache = new Map();

// Environment variables
const WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Sessions directory
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// ============== HELPERS ==============

function extractPhoneFromJid(jid) {
  if (!jid) return null;
  if (jid.includes('@lid')) return null;
  const parts = jid.split('@');
  if (parts.length < 1) return null;
  const digits = parts[0].replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits;
}

function isGroupJid(jid) {
  return jid?.includes('@g.us') || false;
}

function formatJidForSend(phone, isGroup = false) {
  let jid = phone.replace(/\D/g, '');
  if (isGroup || phone.includes('@g.us')) {
    if (!jid.includes('@')) jid = jid + '@g.us';
  } else {
    if (!jid.includes('@')) jid = jid + '@s.whatsapp.net';
  }
  return jid;
}

async function getGroupMetadata(socket, groupJid) {
  if (groupMetadataCache.has(groupJid)) {
    const cached = groupMetadataCache.get(groupJid);
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) {
      return cached.data;
    }
  }
  try {
    const metadata = await socket.groupMetadata(groupJid);
    if (metadata) {
      groupMetadataCache.set(groupJid, { data: metadata, timestamp: Date.now() });
      return metadata;
    }
  } catch (e) {
    console.log(`⚠️ Could not fetch group metadata for ${groupJid}: ${e.message}`);
  }
  return null;
}

// ============== SUPABASE STORAGE ==============

async function uploadMediaToSupabase(buffer, sessionId, mediaType, extension) {
  if (!supabase || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.log('⚠️ Supabase not configured for media upload');
    return null;
  }
  try {
    const timestamp = Date.now();
    const hash = crypto.randomBytes(8).toString('hex');
    const fileName = `${sessionId}/${mediaType}/${timestamp}-${hash}.${extension}`;
    const mimeType = mime.lookup(extension) || 'application/octet-stream';
    console.log(`📤 Uploading media to Supabase: ${fileName}`);
    const { data, error } = await supabase.storage
      .from('whatsapp-media')
      .upload(fileName, buffer, { contentType: mimeType, upsert: false });
    if (error) {
      console.error('❌ Supabase upload error:', error.message);
      return null;
    }
    const { data: urlData } = supabase.storage.from('whatsapp-media').getPublicUrl(fileName);
    console.log(`✅ Media uploaded: ${urlData.publicUrl}`);
    return { url: urlData.publicUrl, mimeType };
  } catch (error) {
    console.error('❌ Upload error:', error.message);
    return null;
  }
}

// ============== MEDIA PROCESSING ==============

async function processMediaMessage(socket, msg, sessionId) {
  try {
    const message = msg.message;
    if (!message) return null;
    let mediaType = null;
    let mediaMessage = null;
    let extension = '';
    if (message.imageMessage) {
      mediaType = 'image'; mediaMessage = message.imageMessage; extension = 'jpg';
    } else if (message.videoMessage) {
      mediaType = 'video'; mediaMessage = message.videoMessage; extension = 'mp4';
    } else if (message.audioMessage) {
      mediaType = message.audioMessage.ptt ? 'ptt' : 'audio';
      mediaMessage = message.audioMessage;
      extension = message.audioMessage.ptt ? 'ogg' : 'mp3';
    } else if (message.documentMessage) {
      mediaType = 'document'; mediaMessage = message.documentMessage;
      const fileName = mediaMessage.fileName || '';
      extension = fileName.split('.').pop() || 'pdf';
    } else if (message.stickerMessage) {
      mediaType = 'sticker'; mediaMessage = message.stickerMessage; extension = 'webp';
    }
    if (!mediaType || !mediaMessage) return null;
    console.log(`📥 Downloading ${mediaType} media...`);
    let buffer = null;
    let retries = 3;
    while (retries > 0 && !buffer) {
      try {
        buffer = await downloadMediaMessage(msg, 'buffer', {}, {
          logger: console, reuploadRequest: socket.updateMediaMessage
        });
      } catch (downloadError) {
        console.log(`⚠️ Download attempt failed, ${retries - 1} retries left...`);
        retries--;
        if (retries > 0) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    if (!buffer) {
      console.error('❌ Failed to download media after all retries');
      return { mediaType };
    }
    console.log(`✅ Media downloaded: ${buffer.length} bytes`);
    const uploadResult = await uploadMediaToSupabase(buffer, sessionId, mediaType, extension);
    if (uploadResult) {
      return { mediaUrl: uploadResult.url, mediaMimeType: uploadResult.mimeType, mediaType };
    }
    return { mediaType };
  } catch (error) {
    console.error('❌ Error processing media:', error.message);
    return null;
  }
}

function hasMedia(msg) {
  const message = msg.message;
  if (!message) return false;
  return !!(message.imageMessage || message.videoMessage || message.audioMessage || message.documentMessage || message.stickerMessage);
}

function getMediaCaption(msg) {
  const message = msg.message;
  if (!message) return '';
  return message.imageMessage?.caption || message.videoMessage?.caption || message.documentMessage?.caption || message.documentMessage?.fileName || '';
}

// ============== WEBHOOK ==============

async function sendWebhook(payload) {
  if (!WEBHOOK_URL) {
    console.log('⚠️ No webhook URL configured');
    return;
  }
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': payload.webhookSecret || '' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      console.log(`📤 Webhook sent: ${payload.event}`);
    } else {
      console.log(`⚠️ Webhook response: ${response.status}`);
    }
  } catch (error) {
    console.error('❌ Webhook error:', error.message);
  }
}

// ============== WHATSAPP SESSION ==============

async function createWhatsAppSession(sessionId, instanceName, webhookSecret) {
  if (sessions.has(sessionId)) {
    console.log(`ℹ️ Session ${instanceName} already exists`);
    return sessions.get(sessionId);
  }
  const sessionPath = path.join(SESSIONS_DIR, instanceName);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  console.log(`📱 Creating session: ${instanceName} (Baileys v${version.join('.')})`);
  console.log(`🚫 History sync: DISABLED - Only real-time messages will be processed`);

  const session = {
    sessionId, instanceName, socket: null, webhookSecret,
    qrCode: null, isConnected: false, phoneNumber: null, pushName: null, profilePicture: null
  };
  sessions.set(sessionId, session);

  const logger = pino({ level: 'silent' });

  const socket = makeWASocket({
    version, logger, printQRInTerminal: true,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    browser: Browsers.macOS('Desktop'),
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
    // ============== v3.6.0: DISABLE HISTORY SYNC ==============
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    fireInitQueries: false
  });

  session.socket = socket;
  socket.ev.on('creds.update', saveCreds);

  // Connection updates
  socket.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    if (qr) {
      session.qrCode = await QRCode.toDataURL(qr);
      console.log(`📱 QR Code generated for ${instanceName}`);
      await sendWebhook({ event: 'qr.update', sessionId, instanceName, webhookSecret, data: { qrCode: session.qrCode } });
    }
    if (connection === 'open') {
      session.isConnected = true;
      session.qrCode = null;
      const user = socket.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || user.notify || null;
        try { session.profilePicture = await socket.profilePictureUrl(user.id, 'image'); } catch (e) { session.profilePicture = null; }
      }
      console.log(`✅ ${instanceName} connected! Phone: ${session.phoneNumber}`);
      console.log(`🚫 History sync disabled - Only new messages will appear`);
      await sendWebhook({
        event: 'connection.update', sessionId, instanceName, webhookSecret,
        data: { connection: 'open', isConnected: true, phoneNumber: session.phoneNumber, pushName: session.pushName, profilePicture: session.profilePicture }
      });
    }
    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;
      console.log(`❌ ${instanceName} disconnected. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);
      await sendWebhook({ event: 'connection.update', sessionId, instanceName, webhookSecret, data: { connection: 'close', isConnected: false, statusCode } });
      if (statusCode === 515) {
        console.log('⚡ Quick reconnect for 515...');
        sessions.delete(sessionId);
        setTimeout(() => createWhatsAppSession(sessionId, instanceName, webhookSecret), 1000);
      } else if (shouldReconnect) {
        sessions.delete(sessionId);
        setTimeout(() => createWhatsAppSession(sessionId, instanceName, webhookSecret), 5000);
      } else {
        sessions.delete(sessionId);
      }
    }
  });

  // ============== v3.6.0: ONLY REAL-TIME MESSAGES ==============
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    // CRITICAL: Only process 'notify' (real-time messages)
    if (type !== 'notify') {
      console.log(`⏭️ Skipping ${messages.length} messages (type: ${type}) - only real-time messages are processed`);
      return;
    }
    console.log(`📨 Processing ${messages.length} REAL-TIME messages`);

    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      const remoteJid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe || false;
      const isGroup = isGroupJid(remoteJid);

      let senderPhone = '';
      let senderName = '';
      let groupName = '';
      let groupProfilePic = null;
      
      if (isGroup) {
        const groupMetadata = await getGroupMetadata(socket, remoteJid);
        if (groupMetadata) {
          groupName = groupMetadata.subject || '';
          console.log(`👥 Group: "${groupName}" (${remoteJid})`);
          try { groupProfilePic = await socket.profilePictureUrl(remoteJid, 'image'); } catch (e) {}
        }
        if (!fromMe) {
          const participantJid = msg.key.participant;
          if (participantJid) {
            senderPhone = extractPhoneFromJid(participantJid) || '';
            senderName = msg.pushName || '';
            console.log(`👤 Sender: "${senderName}" (${senderPhone})`);
          }
        }
      } else if (!fromMe) {
        senderPhone = extractPhoneFromJid(remoteJid) || '';
        senderName = msg.pushName || '';
      }

      let mediaUrl = null;
      let mediaMimeType = null;
      let mediaType = null;
      let mediaCaption = getMediaCaption(msg);

      if (hasMedia(msg)) {
        console.log(`📨 Media message from ${remoteJid}`);
        const mediaResult = await processMediaMessage(socket, msg, sessionId);
        if (mediaResult) {
          mediaUrl = mediaResult.mediaUrl || null;
          mediaMimeType = mediaResult.mediaMimeType || null;
          mediaType = mediaResult.mediaType || null;
        }
      }

      let senderProfilePic = null;
      if (!isGroup) {
        try { senderProfilePic = await socket.profilePictureUrl(remoteJid, 'image'); } catch (e) {}
      }

      await sendWebhook({
        event: 'messages.upsert', sessionId, instanceName, webhookSecret,
        data: {
          messages: [{
            key: msg.key, message: msg.message, messageTimestamp: msg.messageTimestamp, pushName: msg.pushName,
            groupName, groupSubject: groupName, groupProfilePic, isGroup,
            senderPhone, senderName,
            mediaUrl, mediaMimeType, mediaType, mediaCaption,
            senderProfilePic,
            syncType: 'realtime'
          }]
        }
      });
    }
  });

  socket.ev.on('messages.update', async (updates) => {
    await sendWebhook({ event: 'messages.update', sessionId, instanceName, webhookSecret, data: { updates } });
  });

  // ============== v3.6.0: MINIMAL CHAT SYNC ==============
  socket.ev.on('chats.upsert', async (chats) => {
    console.log(`📋 [CHATS.UPSERT] ${chats.length} new/updated chats`);
    const enrichedChats = [];
    for (const chat of chats) {
      const jid = chat.id;
      const isGroup = isGroupJid(jid);
      let enrichedChat = { ...chat };
      if (isGroup) {
        const metadata = await getGroupMetadata(socket, jid);
        if (metadata) {
          enrichedChat.groupSubject = metadata.subject;
          enrichedChat.subject = metadata.subject;
          enrichedChat.groupName = metadata.subject;
          enrichedChat.name = metadata.subject;
          try { enrichedChat.profilePicture = await socket.profilePictureUrl(jid, 'image'); } catch (e) {}
        }
      } else {
        try { enrichedChat.profilePicture = await socket.profilePictureUrl(jid, 'image'); } catch (e) {}
      }
      enrichedChats.push(enrichedChat);
    }
    await sendWebhook({ event: 'chats.upsert', sessionId, instanceName, webhookSecret, data: { chats: enrichedChats } });
  });

  // ============== v3.6.0: IGNORE HISTORY SYNC EVENTS ==============
  socket.ev.on('chats.set', async ({ chats }) => {
    console.log(`🚫 [CHATS.SET] Ignoring ${chats.length} historical chats (history sync disabled)`);
  });

  socket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    console.log(`🚫 [HISTORY SYNC] Ignoring ${chats?.length || 0} chats, ${messages?.length || 0} messages (history sync disabled)`);
  });

  socket.ev.on('contacts.update', async (contacts) => {
    await sendWebhook({ event: 'contacts.update', sessionId, instanceName, webhookSecret, data: { contacts } });
  });

  return session;
}

// ============== API ROUTES ==============

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '3.6.0', historySync: false,
    sessions: sessions.size, mediaSupport: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
    groupMetadataCache: groupMetadataCache.size, timestamp: new Date().toISOString()
  });
});

app.post('/api/instance/create', async (req, res) => {
  try {
    const { sessionId, instanceName, webhookSecret } = req.body;
    if (!sessionId || !instanceName) {
      return res.status(400).json({ error: 'sessionId and instanceName required' });
    }
    const session = await createWhatsAppSession(sessionId, instanceName, webhookSecret || '');
    res.json({ success: true, sessionId: session.sessionId, instanceName: session.instanceName, isConnected: session.isConnected });
  } catch (error) {
    console.error('❌ Create instance error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/instance/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ qrCode: session.qrCode, isConnected: session.isConnected, phoneNumber: session.phoneNumber, pushName: session.pushName, profilePicture: session.profilePicture });
});

app.get('/api/instance/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found', status: 'not_found' });
  res.json({ status: session.isConnected ? 'connected' : (session.qrCode ? 'waiting_qr' : 'connecting'), isConnected: session.isConnected, phoneNumber: session.phoneNumber, pushName: session.pushName, profilePicture: session.profilePicture });
});

app.get('/api/instance/list', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({ sessionId: id, instanceName: session.instanceName, isConnected: session.isConnected, phoneNumber: session.phoneNumber });
  }
  res.json({ sessions: list });
});

app.delete('/api/instance/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  try { if (session.socket) await session.socket.logout(); } catch (e) { console.log('Logout error:', e.message); }
  const sessionPath = path.join(SESSIONS_DIR, session.instanceName);
  if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true });
  sessions.delete(req.params.sessionId);
  res.json({ success: true });
});

app.post('/api/message/send', async (req, res) => {
  try {
    const { sessionId, phone, message, isGroup } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(400).json({ error: 'Session not connected' });
    }
    const jid = formatJidForSend(phone, isGroup);
    console.log(`📤 Sending message to ${jid}: ${message.substring(0, 50)}...`);
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true, jid });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/message/media', async (req, res) => {
  try {
    const { sessionId, phone, mediaUrl, mediaType, caption, isGroup } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(400).json({ error: 'Session not connected' });
    }
    const jid = formatJidForSend(phone, isGroup);
    let messageContent = {};
    if (mediaType === 'image') messageContent = { image: { url: mediaUrl }, caption: caption || '' };
    else if (mediaType === 'video') messageContent = { video: { url: mediaUrl }, caption: caption || '' };
    else if (mediaType === 'audio') messageContent = { audio: { url: mediaUrl }, mimetype: 'audio/mpeg' };
    else if (mediaType === 'document') messageContent = { document: { url: mediaUrl }, fileName: caption || 'document' };
    console.log(`📤 Sending ${mediaType} to ${jid}`);
    await session.socket.sendMessage(jid, messageContent);
    res.json({ success: true, jid });
  } catch (error) {
    console.error('❌ Send media error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/group/:sessionId/:groupId', async (req, res) => {
  try {
    const session = sessions.get(req.params.sessionId);
    if (!session || !session.socket) return res.status(404).json({ error: 'Session not found' });
    const groupJid = req.params.groupId.includes('@') ? req.params.groupId : `${req.params.groupId}@g.us`;
    const metadata = await getGroupMetadata(session.socket, groupJid);
    if (metadata) res.json({ success: true, metadata });
    else res.status(404).json({ error: 'Group not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/profile/:sessionId/:jid', async (req, res) => {
  try {
    const session = sessions.get(req.params.sessionId);
    if (!session || !session.socket) return res.status(404).json({ error: 'Session not found' });
    const jid = req.params.jid.includes('@') ? req.params.jid : `${req.params.jid}@s.whatsapp.net`;
    try {
      const url = await session.socket.profilePictureUrl(jid, 'image');
      res.json({ success: true, url });
    } catch (e) {
      res.json({ success: false, url: null });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== INITIALIZATION ==============

async function init() {
  const baileys = await import('@whiskeysockets/baileys');
  makeWASocket = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore;
  downloadMediaMessage = baileys.downloadMediaMessage;
  Browsers = baileys.Browsers;

  const qrModule = await import('qrcode');
  QRCode = qrModule.default;

  const pinoModule = await import('pino');
  pino = pinoModule.default;

  const mimeModule = await import('mime-types');
  mime = mimeModule.default;

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const { createClient } = await import('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log('✅ Supabase client initialized for media storage');
  } else {
    console.log('⚠️ Supabase not configured - media will not be uploaded');
  }

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`\n🚀 Baileys Server v3.6.0 running on port ${PORT}`);
    console.log(`🚫 History sync: DISABLED`);
    console.log(`📨 Only real-time messages will be processed`);
    console.log(`🔗 Webhook URL: ${WEBHOOK_URL || 'Not configured'}`);
    console.log(`📁 Sessions directory: ${SESSIONS_DIR}`);
    console.log(`☁️ Supabase media: ${supabase ? 'Enabled' : 'Disabled'}\n`);
  });
}

init().catch(console.error);

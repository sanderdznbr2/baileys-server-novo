/**
 * ============================================
 * BAILEYS SERVER v3.3.0
 * ============================================
 * Servidor completo com suporte a mídias, grupos
 * e SINCRONIZAÇÃO COMPLETA de histórico
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

/**
 * Extract phone number from JID
 * Handles: @s.whatsapp.net, @g.us (groups), @lid (linked devices)
 */
function extractPhoneFromJid(jid) {
  if (!jid) return null;
  
  // Skip LIDs (Linked IDs) - they're not real phone numbers
  if (jid.includes('@lid')) {
    return null;
  }
  
  // Extract the number part before @ symbol
  const parts = jid.split('@');
  if (parts.length < 1) return null;
  
  // Clean to digits only
  const digits = parts[0].replace(/\D/g, '');
  
  // Validate minimum length
  if (digits.length < 8) return null;
  
  return digits;
}

/**
 * Check if JID is a group
 */
function isGroupJid(jid) {
  return jid?.includes('@g.us') || false;
}

/**
 * Format JID for sending messages
 */
function formatJidForSend(phone, isGroup = false) {
  let jid = phone.replace(/\D/g, '');
  
  if (isGroup || phone.includes('@g.us')) {
    // Group: use @g.us suffix
    if (!jid.includes('@')) {
      jid = jid + '@g.us';
    }
  } else {
    // Individual: use @s.whatsapp.net suffix
    if (!jid.includes('@')) {
      jid = jid + '@s.whatsapp.net';
    }
  }
  
  return jid;
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

    console.log(`📤 Uploading media to Supabase: ${fileName} (${mimeType})`);

    const { data, error } = await supabase.storage
      .from('whatsapp-media')
      .upload(fileName, buffer, {
        contentType: mimeType,
        upsert: false
      });

    if (error) {
      console.error('❌ Supabase upload error:', error.message);
      return null;
    }

    const { data: urlData } = supabase.storage
      .from('whatsapp-media')
      .getPublicUrl(fileName);

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
      mediaType = 'image';
      mediaMessage = message.imageMessage;
      extension = 'jpg';
    } else if (message.videoMessage) {
      mediaType = 'video';
      mediaMessage = message.videoMessage;
      extension = 'mp4';
    } else if (message.audioMessage) {
      mediaType = message.audioMessage.ptt ? 'ptt' : 'audio';
      mediaMessage = message.audioMessage;
      extension = message.audioMessage.ptt ? 'ogg' : 'mp3';
    } else if (message.documentMessage) {
      mediaType = 'document';
      mediaMessage = message.documentMessage;
      // Get extension from filename or default to pdf
      const fileName = mediaMessage.fileName || '';
      extension = fileName.split('.').pop() || 'pdf';
    } else if (message.stickerMessage) {
      mediaType = 'sticker';
      mediaMessage = message.stickerMessage;
      extension = 'webp';
    }

    if (!mediaType || !mediaMessage) return null;

    console.log(`📥 Downloading ${mediaType} media...`);

    // Download media with retry
    let buffer = null;
    let retries = 3;
    
    while (retries > 0 && !buffer) {
      try {
        buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: console,
            reuploadRequest: socket.updateMediaMessage
          }
        );
      } catch (downloadError) {
        console.log(`⚠️ Download attempt failed, ${retries - 1} retries left...`);
        retries--;
        if (retries > 0) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    if (!buffer) {
      console.error('❌ Failed to download media after all retries');
      return { mediaType }; // Return type but no URL
    }

    console.log(`✅ Media downloaded: ${buffer.length} bytes`);

    // Upload to Supabase
    const uploadResult = await uploadMediaToSupabase(buffer, sessionId, mediaType, extension);
    
    if (uploadResult) {
      return {
        mediaUrl: uploadResult.url,
        mediaMimeType: uploadResult.mimeType,
        mediaType
      };
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
  return !!(
    message.imageMessage ||
    message.videoMessage ||
    message.audioMessage ||
    message.documentMessage ||
    message.stickerMessage
  );
}

function getMediaCaption(msg) {
  const message = msg.message;
  if (!message) return '';
  return message.imageMessage?.caption ||
         message.videoMessage?.caption ||
         message.documentMessage?.caption ||
         message.documentMessage?.fileName ||
         '';
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
      headers: { 
        'Content-Type': 'application/json',
        'x-webhook-secret': payload.webhookSecret || ''
      },
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

  const session = {
    sessionId,
    instanceName,
    socket: null,
    webhookSecret,
    qrCode: null,
    isConnected: false,
    phoneNumber: null,
    pushName: null,
    profilePicture: null
  };

  sessions.set(sessionId, session);

  const logger = pino({ level: 'silent' });

  const socket = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Desktop'),
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
    // Enable history sync
    syncFullHistory: true
  });

  session.socket = socket;

  // Save credentials
  socket.ev.on('creds.update', saveCreds);

  // Connection updates
  socket.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      session.qrCode = await QRCode.toDataURL(qr);
      console.log(`📱 QR Code generated for ${instanceName}`);

      await sendWebhook({
        event: 'qr.update',
        sessionId,
        instanceName,
        webhookSecret,
        data: { qrCode: session.qrCode }
      });
    }

    if (connection === 'open') {
      session.isConnected = true;
      session.qrCode = null;

      const user = socket.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || user.notify || null;

        // Get profile picture
        try {
          session.profilePicture = await socket.profilePictureUrl(user.id, 'image');
        } catch (e) {
          session.profilePicture = null;
        }
      }

      console.log(`✅ ${instanceName} connected! Phone: ${session.phoneNumber}`);

      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        webhookSecret,
        data: {
          connection: 'open',
          isConnected: true,
          phoneNumber: session.phoneNumber,
          pushName: session.pushName,
          profilePicture: session.profilePicture
        }
      });
    }

    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason?.loggedOut;

      console.log(`❌ ${instanceName} disconnected. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        webhookSecret,
        data: { connection: 'close', isConnected: false, statusCode }
      });

      // Quick reconnect for 515 (restartRequired)
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

  // ============== INCOMING MESSAGES (Real-time + History) ==============
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    // Process both 'notify' (real-time) and 'append' (history) messages
    // Skip only 'prepend' to avoid duplicates
    if (type === 'prepend') return;
    
    console.log(`📨 Processing ${messages.length} messages (type: ${type})`);

    for (const msg of messages) {
      // Skip status broadcast
      if (msg.key.remoteJid === 'status@broadcast') continue;

      const remoteJid = msg.key.remoteJid;
      const fromMe = msg.key.fromMe || false;
      const isGroup = isGroupJid(remoteJid);

      // Extract sender info for groups
      let senderPhone = '';
      let senderName = '';
      let groupName = '';
      
      if (isGroup) {
        // Fetch group metadata to get the group name
        try {
          const groupMetadata = await socket.groupMetadata(remoteJid);
          groupName = groupMetadata?.subject || '';
          console.log(`👥 Group: ${groupName}`);
        } catch (e) {
          console.log(`⚠️ Could not fetch group metadata for ${remoteJid}`);
        }
        
        if (!fromMe) {
          // In groups, participant contains the actual sender's JID
          const participantJid = msg.key.participant;
          if (participantJid) {
            senderPhone = extractPhoneFromJid(participantJid) || '';
            senderName = msg.pushName || '';
            console.log(`👤 Sender: ${senderName} (${senderPhone})`);
          }
        }
      } else if (!fromMe) {
        // Individual chat - sender is the contact
        senderPhone = extractPhoneFromJid(remoteJid) || '';
        senderName = msg.pushName || '';
      }

      // Process media only for real-time messages (to avoid downloading old media)
      let mediaUrl = null;
      let mediaMimeType = null;
      let mediaType = null;
      let mediaCaption = getMediaCaption(msg);

      if (type === 'notify' && hasMedia(msg)) {
        console.log(`📨 Media message from ${remoteJid}`);
        const mediaResult = await processMediaMessage(socket, msg, sessionId);
        if (mediaResult) {
          mediaUrl = mediaResult.mediaUrl || null;
          mediaMimeType = mediaResult.mediaMimeType || null;
          mediaType = mediaResult.mediaType || null;
        }
      } else if (hasMedia(msg)) {
        // For history messages, just indicate media type without downloading
        const message = msg.message;
        if (message?.imageMessage) mediaType = 'image';
        else if (message?.videoMessage) mediaType = 'video';
        else if (message?.audioMessage) mediaType = message.audioMessage.ptt ? 'ptt' : 'audio';
        else if (message?.documentMessage) mediaType = 'document';
        else if (message?.stickerMessage) mediaType = 'sticker';
      } else {
        const textContent = msg.message?.conversation || 
                          msg.message?.extendedTextMessage?.text || 
                          '';
        if (textContent) {
          console.log(`📨 Text message from ${remoteJid}: ${textContent.substring(0, 50)}...`);
        }
      }

      // Get sender profile picture (only for non-group individual messages)
      let senderProfilePic = null;
      if (!isGroup && type === 'notify') {
        try {
          senderProfilePic = await socket.profilePictureUrl(remoteJid, 'image');
        } catch (e) {
          // Profile picture not available
        }
      }

      // Send webhook with all data
      await sendWebhook({
        event: 'messages.upsert',
        sessionId,
        instanceName,
        webhookSecret,
        data: {
          messages: [{
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName,
            // Group info
            groupName,
            isGroup,
            // Sender info (for groups)
            senderPhone,
            senderName,
            // Media fields
            mediaUrl,
            mediaMimeType,
            mediaType,
            mediaCaption,
            // Profile
            senderProfilePic,
            // Sync type indicator
            syncType: type
          }]
        }
      });
    }
  });

  // Message status updates
  socket.ev.on('messages.update', async (updates) => {
    await sendWebhook({
      event: 'messages.update',
      sessionId,
      instanceName,
      webhookSecret,
      data: { updates }
    });
  });

  // ============== CHAT SYNC (Initial connection) ==============
  socket.ev.on('chats.set', async ({ chats }) => {
    console.log(`📋 [CHATS.SET] Syncing ${chats.length} chats...`);
    
    // Process in batches to avoid timeout
    const batchSize = 50;
    for (let i = 0; i < chats.length; i += batchSize) {
      const batch = chats.slice(i, i + batchSize);
      console.log(`📋 Sending batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(chats.length/batchSize)}`);
      
      await sendWebhook({
        event: 'chats.set',
        sessionId,
        instanceName,
        webhookSecret,
        data: { 
          chats: batch,
          batchInfo: {
            current: Math.floor(i/batchSize) + 1,
            total: Math.ceil(chats.length/batchSize),
            totalChats: chats.length
          }
        }
      });
    }
    
    console.log(`✅ [CHATS.SET] Finished syncing ${chats.length} chats`);
  });

  // ============== CHAT UPSERT (New chats during session) ==============
  socket.ev.on('chats.upsert', async (chats) => {
    console.log(`📋 [CHATS.UPSERT] ${chats.length} new chats`);
    await sendWebhook({
      event: 'chats.upsert',
      sessionId,
      instanceName,
      webhookSecret,
      data: { chats }
    });
  });

  // ============== MESSAGE HISTORY SYNC ==============
  socket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    console.log(`📜 [HISTORY SYNC] ${chats?.length || 0} chats, ${messages?.length || 0} messages, isLatest: ${isLatest}`);
    
    // Send chats if available
    if (chats && chats.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < chats.length; i += batchSize) {
        const batch = chats.slice(i, i + batchSize);
        await sendWebhook({
          event: 'chats.set',
          sessionId,
          instanceName,
          webhookSecret,
          data: { 
            chats: batch,
            isHistorySync: true
          }
        });
      }
    }
    
    // Send messages if available (in batches)
    if (messages && messages.length > 0) {
      console.log(`📜 Processing ${messages.length} history messages...`);
      const batchSize = 100;
      for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        console.log(`📜 Sending message batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(messages.length/batchSize)}`);
        
        // Process each message in the batch
        for (const msg of batch) {
          const remoteJid = msg.key?.remoteJid;
          if (!remoteJid || remoteJid === 'status@broadcast') continue;
          
          const isGroup = isGroupJid(remoteJid);
          let groupName = '';
          let senderPhone = '';
          let senderName = '';
          
          if (isGroup && !msg.key?.fromMe) {
            const participantJid = msg.key?.participant;
            if (participantJid) {
              senderPhone = extractPhoneFromJid(participantJid) || '';
              senderName = msg.pushName || '';
            }
          }
          
          // Detect media type without downloading
          let mediaType = null;
          const message = msg.message;
          if (message?.imageMessage) mediaType = 'image';
          else if (message?.videoMessage) mediaType = 'video';
          else if (message?.audioMessage) mediaType = message.audioMessage.ptt ? 'ptt' : 'audio';
          else if (message?.documentMessage) mediaType = 'document';
          else if (message?.stickerMessage) mediaType = 'sticker';
          
          await sendWebhook({
            event: 'messages.upsert',
            sessionId,
            instanceName,
            webhookSecret,
            data: {
              messages: [{
                key: msg.key,
                message: msg.message,
                messageTimestamp: msg.messageTimestamp,
                pushName: msg.pushName,
                groupName,
                isGroup,
                senderPhone,
                senderName,
                mediaType,
                syncType: 'history'
              }]
            }
          });
        }
      }
    }
    
    console.log(`✅ [HISTORY SYNC] Complete`);
  });

  // Contacts sync
  socket.ev.on('contacts.update', async (contacts) => {
    await sendWebhook({
      event: 'contacts.update',
      sessionId,
      instanceName,
      webhookSecret,
      data: { contacts }
    });
  });

  return session;
}

// ============== API ROUTES ==============

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '3.3.0',
    sessions: sessions.size,
    mediaSupport: !!(SUPABASE_URL && SUPABASE_SERVICE_KEY),
    timestamp: new Date().toISOString()
  });
});

// Create instance
app.post('/api/instance/create', async (req, res) => {
  try {
    const { sessionId, instanceName, webhookSecret } = req.body;

    if (!sessionId || !instanceName) {
      return res.status(400).json({ error: 'sessionId and instanceName required' });
    }

    const session = await createWhatsAppSession(sessionId, instanceName, webhookSecret || '');

    res.json({
      success: true,
      sessionId: session.sessionId,
      instanceName: session.instanceName,
      isConnected: session.isConnected
    });
  } catch (error) {
    console.error('❌ Create instance error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get QR Code
app.get('/api/instance/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  res.json({
    qrCode: session.qrCode,
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    profilePicture: session.profilePicture
  });
});

// Get status
app.get('/api/instance/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found', status: 'not_found' });
  }

  res.json({
    status: session.isConnected ? 'connected' : (session.qrCode ? 'waiting_qr' : 'connecting'),
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    profilePicture: session.profilePicture
  });
});

// List all sessions
app.get('/api/instance/list', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      sessionId: id,
      instanceName: session.instanceName,
      isConnected: session.isConnected,
      phoneNumber: session.phoneNumber
    });
  }
  res.json({ sessions: list });
});

// Delete session
app.delete('/api/instance/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);

  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  try {
    if (session.socket) {
      await session.socket.logout();
    }
  } catch (e) {
    console.log('Logout error:', e.message);
  }

  // Delete session files
  const sessionPath = path.join(SESSIONS_DIR, session.instanceName);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true });
  }

  sessions.delete(req.params.sessionId);
  res.json({ success: true });
});

// Send text message
app.post('/api/message/send-text', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;

    const session = sessions.get(sessionId);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(400).json({ error: 'Session not connected' });
    }

    // Detect if it's a group
    const isGroup = phone.includes('@g.us') || phone.length > 15;
    const jid = formatJidForSend(phone, isGroup);

    const result = await session.socket.sendMessage(jid, { text: message });

    res.json({ 
      success: true, 
      to: jid,
      messageId: result?.key?.id 
    });
  } catch (error) {
    console.error('❌ Send message error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Send media message
app.post('/api/message/send-media', async (req, res) => {
  try {
    const { sessionId, phone, mediaUrl, mediaType, caption, fileName } = req.body;

    const session = sessions.get(sessionId);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(400).json({ error: 'Session not connected' });
    }

    const isGroup = phone.includes('@g.us') || phone.length > 15;
    const jid = formatJidForSend(phone, isGroup);

    let content;
    switch (mediaType) {
      case 'image':
        content = { image: { url: mediaUrl }, caption };
        break;
      case 'video':
        content = { video: { url: mediaUrl }, caption };
        break;
      case 'audio':
        content = { audio: { url: mediaUrl }, mimetype: 'audio/mp4', ptt: false };
        break;
      case 'ptt':
        content = { audio: { url: mediaUrl }, mimetype: 'audio/ogg; codecs=opus', ptt: true };
        break;
      case 'document':
        content = { 
          document: { url: mediaUrl }, 
          mimetype: mime.lookup(fileName || 'file.pdf') || 'application/octet-stream', 
          fileName: fileName || caption || 'document.pdf' 
        };
        break;
      default:
        return res.status(400).json({ error: 'Invalid media type. Use: image, video, audio, ptt, document' });
    }

    const result = await session.socket.sendMessage(jid, content);

    res.json({ 
      success: true, 
      to: jid,
      messageId: result?.key?.id
    });
  } catch (error) {
    console.error('❌ Send media error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============== START SERVER ==============

async function startServer() {
  console.log('🚀 Starting Baileys Server v3.3.0...');
  
  // Dynamic imports for ESM modules
  const baileysModule = await import('@whiskeysockets/baileys');
  makeWASocket = baileysModule.default;
  useMultiFileAuthState = baileysModule.useMultiFileAuthState;
  DisconnectReason = baileysModule.DisconnectReason;
  fetchLatestBaileysVersion = baileysModule.fetchLatestBaileysVersion;
  makeCacheableSignalKeyStore = baileysModule.makeCacheableSignalKeyStore;
  downloadMediaMessage = baileysModule.downloadMediaMessage;
  Browsers = baileysModule.Browsers;

  QRCode = require('qrcode');
  pino = require('pino');
  mime = require('mime-types');

  // Initialize Supabase client if credentials available
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    console.log('✅ Supabase Storage configured for media uploads');
  } else {
    console.log('⚠️ Supabase not configured - media will not be uploaded');
    console.log('   Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to enable media support');
  }

  const PORT = process.env.PORT || 3333;
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('============================================');
    console.log(`🚀 Baileys Server v3.3.0 running on port ${PORT}`);
    console.log('============================================');
    console.log(`📡 Webhook URL: ${WEBHOOK_URL || 'Not configured'}`);
    console.log(`📸 Media Support: ${supabase ? '✅ Enabled' : '❌ Disabled'}`);
    console.log('📜 History Sync: ✅ Enabled');
    console.log('============================================');
    console.log('');
  });
}

startServer().catch(console.error);

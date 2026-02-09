/**
 * Baileys Server v4.6.0 - Proactive Metadata Sync
 * 
 * NOVIDADES v4.6.0:
 * - SYNC PROATIVO de metadados após conexão (fotos + nomes)
 * - Função syncAllMetadata busca foto e nome de TODOS os chats
 * - Webhook 'contact.metadata' enviado para cada contato/grupo
 * - Cache global de nomes de contatos por JID
 * - Download de STICKERS para storage
 * - Histórico de mensagens: últimas 6 horas
 */

const express = require('express');
const cors = require('cors');
const http = require('http');
const { 
  default: makeWASocket, 
  useMultiFileAuthState, 
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// Configuração
const PORT = process.env.PORT || 3333;
const SUPABASE_WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const logger = pino({ level: 'silent' });

// Express app
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Armazena sessões ativas
const sessions = new Map();

// Cache de nomes de contatos por JID (para enriquecer mensagens)
const contactNamesCache = new Map();

// Controle de concorrência para downloads
const downloadSemaphore = {
  current: 0,
  max: 5,
  queue: []
};

async function acquireDownload() {
  if (downloadSemaphore.current < downloadSemaphore.max) {
    downloadSemaphore.current++;
    return true;
  }
  return new Promise(resolve => {
    downloadSemaphore.queue.push(resolve);
  });
}

function releaseDownload() {
  downloadSemaphore.current--;
  if (downloadSemaphore.queue.length > 0) {
    const next = downloadSemaphore.queue.shift();
    downloadSemaphore.current++;
    next(true);
  }
}

// Helper para delay
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Função para buscar metadados de contato/grupo
async function fetchContactMetadata(socket, jid) {
  const metadata = {
    profilePicture: null,
    status: null,
    groupSubject: null,
    groupDescription: null,
    groupParticipants: null
  };

  const isGroup = jid.endsWith('@g.us');

  try {
    // Foto de perfil
    try {
      metadata.profilePicture = await socket.profilePictureUrl(jid, 'image');
    } catch (e) {}

    if (isGroup) {
      try {
        const groupMeta = await socket.groupMetadata(jid);
        metadata.groupSubject = groupMeta.subject || null;
        metadata.groupDescription = groupMeta.desc || null;
        metadata.groupParticipants = groupMeta.participants?.map(p => ({
          jid: p.id,
          isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
          isSuperAdmin: p.admin === 'superadmin'
        })) || [];
      } catch (e) {
        console.log(`Erro metadados grupo ${jid}:`, e.message);
      }
    } else {
      try {
        const statusResult = await socket.fetchStatus(jid);
        if (statusResult?.status) {
          metadata.status = statusResult.status;
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error(`Erro metadados ${jid}:`, e.message);
  }

  return metadata;
}

// ===== v4.6.0: SYNC PROATIVO DE METADADOS =====
// Busca fotos de perfil e nomes para TODOS os chats logo após conexão
async function syncAllMetadata(socket, session, webhookUrl, webhookSecret, sessionId, instanceName) {
  try {
    const chats = Array.from(session.allChats.values());
    console.log(`📸 Sincronizando metadados para ${chats.length} chats...`);
    
    let processed = 0;
    const BATCH_SIZE = 10;
    
    for (let i = 0; i < chats.length; i += BATCH_SIZE) {
      const batch = chats.slice(i, i + BATCH_SIZE);
      
      for (const chat of batch) {
        const jid = chat.id || chat.jid;
        if (!jid || jid === 'status@broadcast') continue;
        
        try {
          const metadata = await fetchContactMetadata(socket, jid);
          const isGroup = jid.endsWith('@g.us');
          
          // Determinar nome
          let contactName = null;
          if (isGroup) {
            contactName = metadata.groupSubject || chat.subject || chat.name || null;
          } else {
            contactName = contactNamesCache.get(jid) || chat.name || chat.notify || null;
          }
          
          // Enviar webhook com metadados enriquecidos
          if (metadata.profilePicture || contactName) {
            await sendWebhook({
              event: 'contact.metadata',
              sessionId,
              instanceName,
              data: {
                jid,
                phone: jid.split('@')[0].replace(/\D/g, ''),
                name: contactName,
                profilePicture: metadata.profilePicture,
                isGroup,
                groupSubject: isGroup ? contactName : null,
                groupDescription: metadata.groupDescription,
                groupParticipants: metadata.groupParticipants
              }
            }, webhookUrl, webhookSecret);
          }
          
          processed++;
        } catch (e) {
          // Silenciar erros individuais
        }
      }
      
      // Delay entre batches para não sobrecarregar
      if (i + BATCH_SIZE < chats.length) {
        await delay(300);
      }
    }
    
    console.log(`✅ Metadados sincronizados: ${processed}/${chats.length} chats`);
  } catch (e) {
    console.error('Erro sync metadados:', e.message);
  }
}

// Upload mídia para Supabase storage
async function uploadMediaToStorage(buffer, sessionId, messageId, mediaType) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !buffer) return null;
  
  try {
    const extMap = {
      'image': 'jpg',
      'video': 'mp4',
      'audio': 'ogg',
      'ptt': 'ogg',
      'document': 'pdf',
      'sticker': 'webp'
    };
    const ext = extMap[mediaType] || 'bin';
    const fileName = `${sessionId}/${Date.now()}_${messageId}.${ext}`;
    
    const uploadResponse = await fetch(
      `${SUPABASE_URL}/storage/v1/object/whatsapp-media/${fileName}`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/octet-stream'
        },
        body: buffer
      }
    );

    if (uploadResponse.ok) {
      return `${SUPABASE_URL}/storage/v1/object/public/whatsapp-media/${fileName}`;
    }
  } catch (e) {
    console.error('Erro upload mídia:', e.message);
  }
  return null;
}

// Enviar webhook via fetch puro
async function sendWebhook(payload, webhookUrl, webhookSecret) {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-secret': webhookSecret || ''
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      console.error('Webhook error:', response.status);
    }
  } catch (error) {
    console.error('Webhook fetch error:', error.message);
  }
}

// Criar sessão WhatsApp
async function createSession(config) {
  const { sessionId, instanceName, webhookUrl, webhookSecret } = config;
  
  if (sessions.has(sessionId)) {
    console.log(`Sessão ${instanceName} já existe`);
    return sessions.get(sessionId);
  }

  const sessionPath = path.join(__dirname, 'sessions', instanceName);
  
  if (!fs.existsSync(path.join(__dirname, 'sessions'))) {
    fs.mkdirSync(path.join(__dirname, 'sessions'), { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  
  console.log(`📱 Criando sessão: ${instanceName} (Baileys v${version.join('.')})`);

  const session = {
    sessionId,
    instanceName,
    socket: null,
    webhookUrl,
    webhookSecret,
    qrCode: null,
    isConnected: false,
    phoneNumber: null,
    pushName: null,
    profilePicture: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 10,
    allContacts: new Map(),
    allChats: new Map()
  };

  sessions.set(sessionId, session);

  const socket = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: ['Lovable CRM', 'Chrome', '120.0.0'],
    connectTimeoutMs: 60000,
    qrTimeout: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 20000,
    syncFullHistory: true
  });

  session.socket = socket;

  // Salvar credenciais
  socket.ev.on('creds.update', saveCreds);

  // Atualizações de conexão
  socket.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      try {
        const qrDataUrl = await QRCode.toDataURL(qr);
        session.qrCode = qrDataUrl;
        
        await sendWebhook({
          event: 'qr.update',
          sessionId,
          instanceName,
          data: { qrCode: qrDataUrl }
        }, webhookUrl, webhookSecret);
        
        console.log(`📱 QR Code gerado para ${instanceName}`);
      } catch (qrError) {
        console.error('Erro ao gerar QR Code:', qrError.message);
      }
    }

    if (connection === 'open') {
      session.isConnected = true;
      session.qrCode = null;
      session.reconnectAttempts = 0;
      
      const user = socket.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || user.notify || null;
        
        try {
          session.profilePicture = await socket.profilePictureUrl(user.id, 'image');
        } catch (e) {}
      }
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: {
          connection: 'open',
          isConnected: true,
          phoneNumber: session.phoneNumber,
          pushName: session.pushName,
          profilePicture: session.profilePicture
        }
      }, webhookUrl, webhookSecret);
      
      console.log(`✅ ${instanceName} conectado!`);
      
      // ===== v4.6.0: SYNC PROATIVO DE METADADOS APÓS CONEXÃO =====
      // Aguardar 3s para estabilizar, depois buscar fotos e nomes para TODOS os chats
      setTimeout(async () => {
        console.log(`📸 Iniciando sync proativo de metadados para ${instanceName}...`);
        await syncAllMetadata(socket, session, webhookUrl, webhookSecret, sessionId, instanceName);
      }, 3000);
    }

    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      
      console.log(`❌ ${instanceName} desconectado. Código: ${statusCode}`);
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: {
          connection: 'close',
          isConnected: false,
          statusCode,
          shouldReconnect
        }
      }, webhookUrl, webhookSecret);

      if (shouldReconnect && session.reconnectAttempts < session.maxReconnectAttempts) {
        session.reconnectAttempts++;
        const reconnectDelay = Math.min(5000 * Math.pow(1.5, session.reconnectAttempts - 1), 60000);
        console.log(`🔄 Reconectando em ${reconnectDelay/1000}s`);
        
        setTimeout(() => {
          sessions.delete(sessionId);
          createSession(config);
        }, reconnectDelay);
      } else if (statusCode === DisconnectReason.loggedOut) {
        sessions.delete(sessionId);
      }
    }
  });

  // ===== SYNC COMPLETO DE CONTATOS =====
  socket.ev.on('contacts.set', async ({ contacts }) => {
    console.log(`📇 contacts.set: ${contacts.length} contatos recebidos`);
    
    // Armazena no cache da sessão e no cache global de nomes
    for (const contact of contacts) {
      const jid = contact.id || contact.jid;
      if (jid) {
        session.allContacts.set(jid, contact);
        // Cache nome para uso em mensagens
        const name = contact.name || contact.notify || contact.pushName || contact.verifiedName;
        if (name) {
          contactNamesCache.set(jid, name);
        }
      }
    }
    
    // Envia em batches para evitar timeout
    const BATCH_SIZE = 50;
    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
      const batch = contacts.slice(i, i + BATCH_SIZE);
      
      await sendWebhook({
        event: 'contacts.set',
        sessionId,
        instanceName,
        data: { 
          contacts: batch,
          batch: Math.floor(i / BATCH_SIZE) + 1,
          totalBatches: Math.ceil(contacts.length / BATCH_SIZE),
          totalContacts: contacts.length
        }
      }, webhookUrl, webhookSecret);
      
      if (i + BATCH_SIZE < contacts.length) {
        await delay(200);
      }
    }
    
    console.log(`✅ Todos os ${contacts.length} contatos enviados`);
  });

  socket.ev.on('contacts.upsert', async (contacts) => {
    console.log(`📇 contacts.upsert: ${contacts.length} contatos`);
    
    for (const contact of contacts) {
      const jid = contact.id || contact.jid;
      if (jid) {
        session.allContacts.set(jid, contact);
        const name = contact.name || contact.notify || contact.pushName || contact.verifiedName;
        if (name) {
          contactNamesCache.set(jid, name);
        }
      }
    }
    
    await sendWebhook({
      event: 'contacts.upsert',
      sessionId,
      instanceName,
      data: { contacts }
    }, webhookUrl, webhookSecret);
  });

  // ===== SYNC COMPLETO DE CHATS =====
  socket.ev.on('chats.set', async ({ chats }) => {
    console.log(`💬 chats.set: ${chats.length} chats recebidos`);
    
    for (const chat of chats) {
      const jid = chat.id || chat.jid;
      if (jid) {
        session.allChats.set(jid, chat);
      }
    }
    
    // Enriquece chats em batches
    const BATCH_SIZE = 30;
    const enrichedChats = [];
    
    for (let i = 0; i < chats.length; i++) {
      const chat = chats[i];
      try {
        const jid = chat?.id || chat?.jid;
        if (!jid || jid === 'status@broadcast') continue;

        const meta = await fetchContactMetadata(socket, jid);
        const isGroup = jid.endsWith('@g.us');

        // ===== v4.5.0: Melhor extração de nomes =====
        let contactName = null;
        if (isGroup) {
          // Grupos: prioridade para metadados do grupo
          contactName = meta.groupSubject || chat.subject || chat.groupSubject || chat.name || null;
        } else {
          // Contatos individuais: buscar do cache ou chat
          contactName = contactNamesCache.get(jid) || chat.name || chat.notify || chat.pushName || chat.verifiedName || null;
        }

        const enriched = {
          ...chat,
          id: jid,
          jid,
          name: contactName,
          contactName,
          profilePicture: meta.profilePicture || chat.profilePicture || chat.imgUrl || null,
        };

        if (isGroup) {
          enriched.groupSubject = contactName;
          enriched.metadata = {
            ...(chat.metadata || {}),
            subject: contactName,
            desc: meta.groupDescription || null,
            participants: meta.groupParticipants || null,
          };
        }

        enrichedChats.push(enriched);
        
        if (i % 10 === 0 && i > 0) {
          await delay(100);
        }
      } catch (e) {
        console.log('Erro ao enriquecer chat:', e?.message || e);
      }
      
      if (enrichedChats.length >= BATCH_SIZE || i === chats.length - 1) {
        if (enrichedChats.length > 0) {
          await sendWebhook({
            event: 'chats.set',
            sessionId,
            instanceName,
            data: { 
              chats: [...enrichedChats],
              batch: Math.floor(i / BATCH_SIZE) + 1,
              totalChats: chats.length
            }
          }, webhookUrl, webhookSecret);
          
          enrichedChats.length = 0;
          await delay(150);
        }
      }
    }
    
    console.log(`✅ Todos os ${chats.length} chats processados`);
  });

  socket.ev.on('chats.upsert', async (chats) => {
    console.log(`💬 chats.upsert: ${chats.length} chats`);
    
    for (const chat of chats) {
      const jid = chat.id || chat.jid;
      if (jid) {
        session.allChats.set(jid, chat);
      }
    }
    
    await sendWebhook({
      event: 'chats.upsert',
      sessionId,
      instanceName,
      data: { chats }
    }, webhookUrl, webhookSecret);
  });

  // ===== HISTÓRICO DE MENSAGENS - 6 HORAS =====
  socket.ev.on('messaging-history.set', async ({ chats = [], contacts = [], messages = [], isLatest }) => {
    try {
      console.log(`📥 History set: chats=${chats.length} contacts=${contacts.length} messages=${messages.length} latest=${isLatest}`);

      // Processa contatos adicionais do histórico
      if (contacts && contacts.length > 0) {
        for (const contact of contacts) {
          const jid = contact.id || contact.jid;
          if (jid) {
            session.allContacts.set(jid, contact);
            const name = contact.name || contact.notify || contact.pushName || contact.verifiedName;
            if (name) {
              contactNamesCache.set(jid, name);
            }
          }
        }
        
        const BATCH_SIZE = 50;
        for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
          const batch = contacts.slice(i, i + BATCH_SIZE);
          await sendWebhook({
            event: 'contacts.set',
            sessionId,
            instanceName,
            data: { contacts: batch }
          }, webhookUrl, webhookSecret);
          await delay(100);
        }
      }

      // ===== Processa mensagens das últimas 6 HORAS =====
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      const cutoff = Date.now() - SIX_HOURS_MS;

      const toMs = (ts) => {
        try {
          if (!ts) return null;
          if (typeof ts === 'number') return ts > 4102444800 ? ts : ts * 1000;
          if (typeof ts === 'string') {
            const n = parseInt(ts, 10);
            if (!isNaN(n)) return n > 4102444800 ? n : n * 1000;
          }
          if (typeof ts === 'object' && ts !== null) {
            if (typeof ts.low === 'number') return ts.low * 1000;
            if (typeof ts.toNumber === 'function') return ts.toNumber() * 1000;
          }
          return null;
        } catch {
          return null;
        }
      };

      const recent = (messages || []).filter((m) => {
        const ms = toMs(m?.messageTimestamp);
        return ms && ms >= cutoff;
      });

      console.log(`📨 Processando ${recent.length} mensagens recentes (últimas 6h)`);

      const BATCH = 20;
      for (let i = 0; i < recent.length; i += BATCH) {
        const slice = recent.slice(i, i + BATCH);

        const mapped = [];
        for (const m of slice) {
          const jid = m?.key?.remoteJid;
          if (!jid || jid === 'status@broadcast') continue;

          const isGroup = jid.endsWith('@g.us');
          const participant = m?.key?.participant;

          // ===== v4.5.0: Melhor extração de remetente em grupos =====
          let senderPhone = null;
          let senderName = null;
          
          if (isGroup && participant) {
            senderPhone = participant.split('@')[0].replace(/\D/g, '');
            // Buscar nome do cache primeiro, depois pushName
            senderName = contactNamesCache.get(participant) || m?.pushName || null;
          }
          
          // Para contatos individuais incoming, usar pushName
          if (!isGroup && !m?.key?.fromMe) {
            senderName = contactNamesCache.get(jid) || m?.pushName || null;
          }

          // ===== v4.5.0: Detectar tipo de mídia incluindo sticker =====
          let mediaType = null;
          let mediaUrl = null;
          const msgContent = m.message;
          
          if (msgContent) {
            if (msgContent.imageMessage) mediaType = 'image';
            else if (msgContent.videoMessage) mediaType = 'video';
            else if (msgContent.audioMessage) {
              mediaType = msgContent.audioMessage.ptt ? 'ptt' : 'audio';
            }
            else if (msgContent.documentMessage) mediaType = 'document';
            else if (msgContent.stickerMessage) mediaType = 'sticker';
          }

          // ===== v4.5.0: Download de stickers e outras mídias do histórico =====
          if (mediaType && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
            try {
              await acquireDownload();
              const buffer = await downloadMediaMessage(m, 'buffer', {});
              if (buffer) {
                mediaUrl = await uploadMediaToStorage(buffer, sessionId, m.key.id, mediaType);
              }
            } catch (e) {
              console.error(`Erro download mídia (${mediaType}):`, e.message);
            } finally {
              releaseDownload();
            }
          }

          mapped.push({
            key: m.key,
            message: m.message,
            messageTimestamp: m.messageTimestamp,
            pushName: m.pushName,
            senderPhone,
            senderName,
            mediaUrl,
            mediaType,
          });
        }

        if (mapped.length > 0) {
          await sendWebhook({
            event: 'messages.upsert',
            sessionId,
            instanceName,
            data: { messages: mapped }
          }, webhookUrl, webhookSecret);
          await delay(100);
        }
      }

      console.log(`✅ Sync inicial concluído (${recent.length} mensagens das últimas 6h)`);
    } catch (e) {
      console.log('❌ Erro no sync inicial:', e?.message || e);
    }
  });

  // ===== MENSAGENS RECEBIDAS EM TEMPO REAL =====
  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      
      const jid = msg.key.remoteJid;
      console.log(`📨 Mensagem de ${jid}`);
      
      // Buscar metadados
      const metadata = await fetchContactMetadata(socket, jid);
      
      // ===== v4.5.0: Detectar mídia incluindo sticker =====
      let mediaUrl = null;
      let mediaType = null;
      const msgContent = msg.message;
      
      if (msgContent) {
        if (msgContent.imageMessage) mediaType = 'image';
        else if (msgContent.videoMessage) mediaType = 'video';
        else if (msgContent.audioMessage) {
          mediaType = msgContent.audioMessage.ptt ? 'ptt' : 'audio';
        }
        else if (msgContent.documentMessage) mediaType = 'document';
        else if (msgContent.stickerMessage) mediaType = 'sticker';
      }

      // ===== v4.5.0: Download de TODAS as mídias incluindo stickers =====
      if (mediaType && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
        try {
          await acquireDownload();
          const buffer = await downloadMediaMessage(msg, 'buffer', {});
          
          if (buffer) {
            mediaUrl = await uploadMediaToStorage(buffer, sessionId, msg.key.id, mediaType);
            console.log(`📎 Mídia ${mediaType} salva: ${mediaUrl ? 'OK' : 'FALHOU'}`);
          }
        } catch (e) {
          console.error('Erro download mídia:', e.message);
        } finally {
          releaseDownload();
        }
      }

      // Dados de grupo
      const isGroup = jid.endsWith('@g.us');
      const participant = msg.key?.participant;
      
      let senderPhone = null;
      let senderName = null;
      
      if (isGroup && participant) {
        senderPhone = participant.split('@')[0].replace(/\D/g, '');
        senderName = contactNamesCache.get(participant) || msg.pushName || null;
      }
      
      if (!isGroup && !msg.key.fromMe) {
        senderName = contactNamesCache.get(jid) || msg.pushName || null;
      }

      // Nome do grupo
      const groupName = isGroup ? (metadata.groupSubject || null) : null;

      // Enviar webhook
      await sendWebhook({
        event: 'messages.upsert',
        sessionId,
        instanceName,
        data: {
          messages: [{
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName,
            mediaUrl,
            mediaType,
            senderPhone,
            senderName,
            groupName,
            contactMetadata: metadata
          }]
        }
      }, webhookUrl, webhookSecret);
    }
  });

  // ===== ATUALIZAÇÃO DE STATUS (LIDAS) =====
  socket.ev.on('messages.update', async (updates) => {
    console.log(`📋 messages.update: ${updates.length} atualizações`);
    
    await sendWebhook({
      event: 'messages.update',
      sessionId,
      instanceName,
      data: { updates }
    }, webhookUrl, webhookSecret);
  });

  // Recibos de leitura
  socket.ev.on('message-receipt.update', async (updates) => {
    console.log(`✅ message-receipt.update: ${updates.length} recibos`);
    
    await sendWebhook({
      event: 'message-receipt.update',
      sessionId,
      instanceName,
      data: { updates }
    }, webhookUrl, webhookSecret);
  });

  return session;
}

// ============ ROTAS ============

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    version: '4.6.0',
    sessions: sessions.size,
    timestamp: new Date().toISOString(),
    historyHours: 6,
    features: ['proactive-metadata-sync', 'sticker-download', 'contact-name-cache', 'group-sender-names']
  });
});

// Criar instância
app.post('/api/instance/create', async (req, res) => {
  try {
    const { sessionId, instanceName, webhookUrl, webhookSecret } = req.body;
    
    if (!sessionId || !instanceName) {
      return res.status(400).json({ error: 'sessionId e instanceName são obrigatórios' });
    }
    
    const session = await createSession({
      sessionId,
      instanceName,
      webhookUrl: webhookUrl || SUPABASE_WEBHOOK_URL,
      webhookSecret: webhookSecret || ''
    });
    
    res.json({
      success: true,
      sessionId: session?.sessionId,
      instanceName: session?.instanceName,
      qrCode: session?.qrCode
    });
  } catch (error) {
    console.error('Erro criar instância:', error);
    res.status(500).json({ error: 'Falha ao criar instância' });
  }
});

// Obter QR Code
app.get('/api/instance/:instanceName/qr', (req, res) => {
  const session = Array.from(sessions.values()).find(s => s.instanceName === req.params.instanceName);
  
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  res.json({
    qrCode: session.qrCode,
    isConnected: session.isConnected
  });
});

// Status da instância
app.get('/api/instance/:instanceName/status', (req, res) => {
  const session = Array.from(sessions.values()).find(s => s.instanceName === req.params.instanceName);
  
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  res.json({
    status: session.isConnected ? 'connected' : 'disconnected',
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    profilePicture: session.profilePicture,
    contactsCount: session.allContacts?.size || 0,
    chatsCount: session.allChats?.size || 0
  });
});

// Logout
app.post('/api/instance/:instanceName/logout', async (req, res) => {
  const session = Array.from(sessions.values()).find(s => s.instanceName === req.params.instanceName);
  
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  try {
    if (session.socket) {
      await session.socket.logout();
    }
    sessions.delete(session.sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deletar instância
app.delete('/api/instance/:instanceName/delete', async (req, res) => {
  const session = Array.from(sessions.values()).find(s => s.instanceName === req.params.instanceName);
  
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  try {
    if (session.socket) {
      await session.socket.logout();
    }
    
    const sessionPath = path.join(__dirname, 'sessions', session.instanceName);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true });
    }
    
    sessions.delete(session.sessionId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Listar instâncias
app.get('/api/instance/list', (req, res) => {
  const sessionList = Array.from(sessions.values()).map(s => ({
    sessionId: s.sessionId,
    instanceName: s.instanceName,
    isConnected: s.isConnected,
    phoneNumber: s.phoneNumber,
    pushName: s.pushName,
    contactsCount: s.allContacts?.size || 0,
    chatsCount: s.allChats?.size || 0
  }));
  
  res.json({ sessions: sessionList });
});

// ===== ENDPOINT PARA SYNC COMPLETO DE CONTATOS =====
app.post('/api/sync/contacts', async (req, res) => {
  try {
    const { instanceName, page = 1, pageSize = 50 } = req.body;
    
    const session = Array.from(sessions.values()).find(s => s.instanceName === instanceName);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(404).json({ error: 'Sessão não encontrada ou desconectada' });
    }
    
    const allContacts = Array.from(session.allContacts.values());
    const totalContacts = allContacts.length;
    const totalPages = Math.ceil(totalContacts / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    
    const contacts = allContacts.slice(startIndex, endIndex);
    
    // Enriquece com metadados
    const enrichedContacts = [];
    for (const contact of contacts) {
      const jid = contact.id || contact.jid;
      if (!jid || jid === 'status@broadcast') continue;
      
      try {
        const meta = await fetchContactMetadata(session.socket, jid);
        enrichedContacts.push({
          ...contact,
          jid,
          profilePicture: meta.profilePicture,
          status: meta.status,
          groupSubject: meta.groupSubject,
          groupDescription: meta.groupDescription
        });
        await delay(50);
      } catch (e) {
        enrichedContacts.push({ ...contact, jid });
      }
    }
    
    res.json({
      success: true,
      page,
      pageSize,
      totalPages,
      totalContacts,
      contacts: enrichedContacts,
      hasMore: page < totalPages
    });
  } catch (error) {
    console.error('Erro sync contatos:', error);
    res.status(500).json({ error: 'Falha no sync de contatos' });
  }
});

// ===== ENDPOINT PARA SYNC COMPLETO DE CHATS =====
app.post('/api/sync/chats', async (req, res) => {
  try {
    const { instanceName, page = 1, pageSize = 30 } = req.body;
    
    const session = Array.from(sessions.values()).find(s => s.instanceName === instanceName);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(404).json({ error: 'Sessão não encontrada ou desconectada' });
    }
    
    const allChats = Array.from(session.allChats.values());
    const totalChats = allChats.length;
    const totalPages = Math.ceil(totalChats / pageSize);
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    
    const chats = allChats.slice(startIndex, endIndex);
    
    // Enriquece com metadados
    const enrichedChats = [];
    for (const chat of chats) {
      const jid = chat.id || chat.jid;
      if (!jid || jid === 'status@broadcast') continue;
      
      try {
        const meta = await fetchContactMetadata(session.socket, jid);
        const isGroup = jid.endsWith('@g.us');
        
        const enriched = {
          ...chat,
          jid,
          profilePicture: meta.profilePicture
        };
        
        if (isGroup) {
          enriched.groupSubject = meta.groupSubject || chat.name;
          enriched.groupDescription = meta.groupDescription;
          enriched.groupParticipants = meta.groupParticipants;
        }
        
        enrichedChats.push(enriched);
        await delay(50);
      } catch (e) {
        enrichedChats.push({ ...chat, jid });
      }
    }
    
    res.json({
      success: true,
      page,
      pageSize,
      totalPages,
      totalChats,
      chats: enrichedChats,
      hasMore: page < totalPages
    });
  } catch (error) {
    console.error('Erro sync chats:', error);
    res.status(500).json({ error: 'Falha no sync de chats' });
  }
});

// Enviar mensagem
app.post('/api/message/send', async (req, res) => {
  try {
    const { instanceName, jid, message } = req.body;
    
    const session = Array.from(sessions.values()).find(s => s.instanceName === instanceName);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(404).json({ error: 'Sessão não encontrada ou desconectada' });
    }
    
    const result = await session.socket.sendMessage(jid, message);
    
    res.json({
      success: true,
      messageId: result.key.id,
      key: result.key
    });
  } catch (error) {
    console.error('Erro enviar:', error);
    res.status(500).json({ error: 'Falha ao enviar' });
  }
});

// Enviar mídia
app.post('/api/message/send-media', async (req, res) => {
  try {
    const { instanceName, jid, mediaUrl, mediaType, caption } = req.body;
    
    const session = Array.from(sessions.values()).find(s => s.instanceName === instanceName);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    let messageContent;
    switch (mediaType) {
      case 'image':
        messageContent = { image: { url: mediaUrl }, caption };
        break;
      case 'video':
        messageContent = { video: { url: mediaUrl }, caption };
        break;
      case 'audio':
        messageContent = { audio: { url: mediaUrl }, mimetype: 'audio/mp4', ptt: false };
        break;
      case 'document':
        messageContent = { document: { url: mediaUrl }, fileName: caption || 'document' };
        break;
      default:
        messageContent = { image: { url: mediaUrl }, caption };
    }
    
    const result = await session.socket.sendMessage(jid, messageContent);
    res.json({ success: true, messageId: result.key.id, key: result.key });
  } catch (error) {
    res.status(500).json({ error: 'Falha ao enviar mídia' });
  }
});

// Enviar voz (PTT)
app.post('/api/message/send-voice', async (req, res) => {
  try {
    const { instanceName, jid, audioUrl } = req.body;
    
    const session = Array.from(sessions.values()).find(s => s.instanceName === instanceName);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    const result = await session.socket.sendMessage(jid, {
      audio: { url: audioUrl },
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true
    });
    
    res.json({ success: true, messageId: result.key.id, key: result.key });
  } catch (error) {
    console.error('Erro enviar voz:', error);
    res.status(500).json({ error: 'Falha ao enviar voz' });
  }
});

// Marcar como lido
app.post('/api/message/read', async (req, res) => {
  try {
    const { instanceName, keys } = req.body;
    
    const session = Array.from(sessions.values()).find(s => s.instanceName === instanceName);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(404).json({ error: 'Sessão não encontrada' });
    }
    
    await session.socket.readMessages(keys);
    res.json({ success: true });
  } catch (error) {
    console.error('Erro marcar como lido:', error);
    res.status(500).json({ error: 'Falha ao marcar como lido' });
  }
});

// Iniciar servidor
server.listen(PORT, () => {
  console.log(`🚀 Baileys Server v4.6.0 rodando na porta ${PORT}`);
  console.log(`📡 Webhook: ${SUPABASE_WEBHOOK_URL || 'não configurado'}`);
  console.log(`📸 Sync proativo de metadados habilitado`);
  console.log(`🔄 Sync completo de contatos habilitado`);
  console.log(`⏰ Histórico de mensagens: últimas 6 horas`);
  console.log(`🎨 Stickers: download habilitado`);
});

//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImluZGV4LmpzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQmFpbGV5cyBTZXJ2ZXIgdjQuNi4wIC0gUHJvYWN0aXZlIE1ldGFkYXRhIFN5bmNcbiAqIFxuICogTk9WSURBREVTIHY0LjYuMDpcbiAqIC0gU1lOQyBQUk9BVElWTyBkZSBtZXRhZGFkb3MgYXDDs3MgY29uZXjDo28gKGZvdG9zICsgbm9tZXMpXG4gKiAtIEZ1bsOnw6NvIHN5bmNBbGxNZXRhZGF0YSBidXNjYSBmb3RvIGUgbm9tZSBkZSBUT0RPUyBvcyBjaGF0c1xuICogLSBXZWJob29rICdjb250YWN0Lm1ldGFkYXRhJyBlbnZpYWRvIHBhcmEgY2FkYSBjb250YXRvL2dydXBvXG4gKiAtIENhY2hlIGdsb2JhbCBkZSBub21lcyBkZSBjb250YXRvcyBwb3IgSklEXG4gKiAtIERvd25sb2FkIGRlIFNUSUNLRVJTIHBhcmEgc3RvcmFnZVxuICogLSBIaXN0w7NyaWNvIGRlIG1lbnNhZ2Vuczogw7psdGltYXMgNiBob3Jhc1xuICovXG5cbmNvbnN0IGV4cHJlc3MgPSByZXF1aXJlKCdleHByZXNzJyk7XG5jb25zdCBjb3JzID0gcmVxdWlyZSgnY29ycycpO1xuY29uc3QgaHR0cCA9IHJlcXVpcmUoJ2h0dHAnKTtcbmNvbnN0IHsgXG4gIGRlZmF1bHQ6IG1ha2VXQVNvY2tldCwgXG4gIHVzZU11bHRpRmlsZUF1dGhTdGF0ZSwgXG4gIERpc2Nvbm5lY3RSZWFzb24sXG4gIGZldGNoTGF0ZXN0QmFpbGV5c1ZlcnNpb24sXG4gIG1ha2VDYWNoZWFibGVTaWduYWxLZXlTdG9yZSxcbiAgZG93bmxvYWRNZWRpYU1lc3NhZ2Vcbn0gPSByZXF1aXJlKCdAd2hpc2tleXNvY2tldHMvYmFpbGV5cycpO1xuY29uc3QgUVJDb2RlID0gcmVxdWlyZSgncXJjb2RlJyk7XG5jb25zdCBwaW5vID0gcmVxdWlyZSgncGlubycpO1xuY29uc3QgZnMgPSByZXF1aXJlKCdmcycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuLy8gQ29uZmlndXJhw6fDo29cbmNvbnN0IFBPUlQgPSBwcm9jZXNzLmVudi5QT1JUIHx8IDMzMzM7XG5jb25zdCBTVVBBQkFTRV9XRUJIT09LX1VSTCA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX1dFQkhPT0tfVVJMO1xuY29uc3QgU1VQQUJBU0VfVVJMID0gcHJvY2Vzcy5lbnYuU1VQQUJBU0VfVVJMO1xuY29uc3QgU1VQQUJBU0VfU0VSVklDRV9ST0xFX0tFWSA9IHByb2Nlc3MuZW52LlNVUEFCQVNFX1NFUlZJQ0VfUk9MRV9LRVk7XG5cbmNvbnN0IGxvZ2dlciA9IHBpbm8oeyBsZXZlbDogJ3NpbGVudCcgfSk7XG5cbi8vIEV4cHJlc3MgYXBwXG5jb25zdCBhcHAgPSBleHByZXNzKCk7XG5jb25zdCBzZXJ2ZXIgPSBodHRwLmNyZWF0ZVNlcnZlcihhcHApO1xuXG5hcHAudXNlKGNvcnMoKSk7XG5hcHAudXNlKGV4cHJlc3MuanNvbih7IGxpbWl0OiAnNTBtYicgfSkpO1xuXG4vLyBBcm1hemVuYSBzZXNzw7VlcyBhdGl2YXNcbmNvbnN0IHNlc3Npb25zID0gbmV3IE1hcCgpO1xuXG4vLyBDYWNoZSBkZSBub21lcyBkZSBjb250YXRvcyBwb3IgSklEIChwYXJhIGVucmlxdWVjZXIgbWVuc2FnZW5zKVxuY29uc3QgY29udGFjdE5hbWVzQ2FjaGUgPSBuZXcgTWFwKCk7XG5cbi8vIENvbnRyb2xlIGRlIGNvbmNvcnLDqm5jaWEgcGFyYSBkb3dubG9hZHNcbmNvbnN0IGRvd25sb2FkU2VtYXBob3JlID0ge1xuICBjdXJyZW50OiAwLFxuICBtYXg6IDUsXG4gIHF1ZXVlOiBbXVxufTtcblxuYXN5bmMgZnVuY3Rpb24gYWNxdWlyZURvd25sb2FkKCkge1xuICBpZiAoZG93bmxvYWRTZW1hcGhvcmUuY3VycmVudCA8IGRvd25sb2FkU2VtYXBob3JlLm1heCkge1xuICAgIGRvd25sb2FkU2VtYXBob3JlLmN1cnJlbnQrKztcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuICByZXR1cm4gbmV3IFByb21pc2UocmVzb2x2ZSA9PiB7XG4gICAgZG93bmxvYWRTZW1hcGhvcmUucXVldWUucHVzaChyZXNvbHZlKTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIHJlbGVhc2VEb3dubG9hZCgpIHtcbiAgZG93bmxvYWRTZW1hcGhvcmUuY3VycmVudC0tO1xuICBpZiAoZG93bmxvYWRTZW1hcGhvcmUucXVldWUubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IG5leHQgPSBkb3dubG9hZFNlbWFwaG9yZS5xdWV1ZS5zaGlmdCgpO1xuICAgIGRvd25sb2FkU2VtYXBob3JlLmN1cnJlbnQrKztcbiAgICBuZXh0KHRydWUpO1xuICB9XG59XG5cbi8vIEhlbHBlciBwYXJhIGRlbGF5XG5jb25zdCBkZWxheSA9IChtcykgPT4gbmV3IFByb21pc2UociA9PiBzZXRUaW1lb3V0KHIsIG1zKSk7XG5cbi8vIEZ1bsOnw6NvIHBhcmEgYnVzY2FyIG1ldGFkYWRvcyBkZSBjb250YXRvL2dydXBvXG5hc3luYyBmdW5jdGlvbiBmZXRjaENvbnRhY3RNZXRhZGF0YShzb2NrZXQsIGppZCkge1xuICBjb25zdCBtZXRhZGF0YSA9IHtcbiAgICBwcm9maWxlUGljdHVyZTogbnVsbCxcbiAgICBzdGF0dXM6IG51bGwsXG4gICAgZ3JvdXBTdWJqZWN0OiBudWxsLFxuICAgIGdyb3VwRGVzY3JpcHRpb246IG51bGwsXG4gICAgZ3JvdXBQYXJ0aWNpcGFudHM6IG51bGxcbiAgfTtcblxuICBjb25zdCBpc0dyb3VwID0gamlkLmVuZHNXaXRoKCdAZy51cycpO1xuXG4gIHRyeSB7XG4gICAgLy8gRm90byBkZSBwZXJmaWxcbiAgICB0cnkge1xuICAgICAgbWV0YWRhdGEucHJvZmlsZVBpY3R1cmUgPSBhd2FpdCBzb2NrZXQucHJvZmlsZVBpY3R1cmVVcmwoamlkLCAnaW1hZ2UnKTtcbiAgICB9IGNhdGNoIChlKSB7fVxuXG4gICAgaWYgKGlzR3JvdXApIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IGdyb3VwTWV0YSA9IGF3YWl0IHNvY2tldC5ncm91cE1ldGFkYXRhKGppZCk7XG4gICAgICAgIG1ldGFkYXRhLmdyb3VwU3ViamVjdCA9IGdyb3VwTWV0YS5zdWJqZWN0IHx8IG51bGw7XG4gICAgICAgIG1ldGFkYXRhLmdyb3VwRGVzY3JpcHRpb24gPSBncm91cE1ldGEuZGVzYyB8fCBudWxsO1xuICAgICAgICBtZXRhZGF0YS5ncm91cFBhcnRpY2lwYW50cyA9IGdyb3VwTWV0YS5wYXJ0aWNpcGFudHM/Lm1hcChwID0+ICh7XG4gICAgICAgICAgamlkOiBwLmlkLFxuICAgICAgICAgIGlzQWRtaW46IHAuYWRtaW4gPT09ICdhZG1pbicgfHwgcC5hZG1pbiA9PT0gJ3N1cGVyYWRtaW4nLFxuICAgICAgICAgIGlzU3VwZXJBZG1pbjogcC5hZG1pbiA9PT0gJ3N1cGVyYWRtaW4nXG4gICAgICAgIH0pKSB8fCBbXTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgY29uc29sZS5sb2coYEVycm8gbWV0YWRhZG9zIGdydXBvICR7amlkfTpgLCBlLm1lc3NhZ2UpO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCBzdGF0dXNSZXN1bHQgPSBhd2FpdCBzb2NrZXQuZmV0Y2hTdGF0dXMoamlkKTtcbiAgICAgICAgaWYgKHN0YXR1c1Jlc3VsdD8uc3RhdHVzKSB7XG4gICAgICAgICAgbWV0YWRhdGEuc3RhdHVzID0gc3RhdHVzUmVzdWx0LnN0YXR1cztcbiAgICAgICAgfVxuICAgICAgfSBjYXRjaCAoZSkge31cbiAgICB9XG4gIH0gY2F0Y2ggKGUpIHtcbiAgICBjb25zb2xlLmVycm9yKGBFcnJvIG1ldGFkYWRvcyAke2ppZH06YCwgZS5tZXNzYWdlKTtcbiAgfVxuXG4gIHJldHVybiBtZXRhZGF0YTtcbn1cblxuLy8gPT09PT0gdjQuNi4wOiBTWU5DIFBST0FUSVZPIERFIE1FVEFEQURPUyA9PT09PVxuLy8gQnVzY2EgZm90b3MgZGUgcGVyZmlsIGUgbm9tZXMgcGFyYSBUT0RPUyBvcyBjaGF0cyBsb2dvIGFww7NzIGNvbmV4w6NvXG5hc3luYyBmdW5jdGlvbiBzeW5jQWxsTWV0YWRhdGEoc29ja2V0LCBzZXNzaW9uLCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0LCBzZXNzaW9uSWQsIGluc3RhbmNlTmFtZSkge1xuICB0cnkge1xuICAgIGNvbnN0IGNoYXRzID0gQXJyYXkuZnJvbShzZXNzaW9uLmFsbENoYXRzLnZhbHVlcygpKTtcbiAgICBjb25zb2xlLmxvZyhg8J+TuCBTaW5jcm9uaXphbmRvIG1ldGFkYWRvcyBwYXJhICR7Y2hhdHMubGVuZ3RofSBjaGF0cy4uLmApO1xuICAgIFxuICAgIGxldCBwcm9jZXNzZWQgPSAwO1xuICAgIGNvbnN0IEJBVENIX1NJWkUgPSAxMDtcbiAgICBcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNoYXRzLmxlbmd0aDsgaSArPSBCQVRDSF9TSVpFKSB7XG4gICAgICBjb25zdCBiYXRjaCA9IGNoYXRzLnNsaWNlKGksIGkgKyBCQVRDSF9TSVpFKTtcbiAgICAgIFxuICAgICAgZm9yIChjb25zdCBjaGF0IG9mIGJhdGNoKSB7XG4gICAgICAgIGNvbnN0IGppZCA9IGNoYXQuaWQgfHwgY2hhdC5qaWQ7XG4gICAgICAgIGlmICghamlkIHx8IGppZCA9PT0gJ3N0YXR1c0Bicm9hZGNhc3QnKSBjb250aW51ZTtcbiAgICAgICAgXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgY29uc3QgbWV0YWRhdGEgPSBhd2FpdCBmZXRjaENvbnRhY3RNZXRhZGF0YShzb2NrZXQsIGppZCk7XG4gICAgICAgICAgY29uc3QgaXNHcm91cCA9IGppZC5lbmRzV2l0aCgnQGcudXMnKTtcbiAgICAgICAgICBcbiAgICAgICAgICAvLyBEZXRlcm1pbmFyIG5vbWVcbiAgICAgICAgICBsZXQgY29udGFjdE5hbWUgPSBudWxsO1xuICAgICAgICAgIGlmIChpc0dyb3VwKSB7XG4gICAgICAgICAgICBjb250YWN0TmFtZSA9IG1ldGFkYXRhLmdyb3VwU3ViamVjdCB8fCBjaGF0LnN1YmplY3QgfHwgY2hhdC5uYW1lIHx8IG51bGw7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnRhY3ROYW1lID0gY29udGFjdE5hbWVzQ2FjaGUuZ2V0KGppZCkgfHwgY2hhdC5uYW1lIHx8IGNoYXQubm90aWZ5IHx8IG51bGw7XG4gICAgICAgICAgfVxuICAgICAgICAgIFxuICAgICAgICAgIC8vIEVudmlhciB3ZWJob29rIGNvbSBtZXRhZGFkb3MgZW5yaXF1ZWNpZG9zXG4gICAgICAgICAgaWYgKG1ldGFkYXRhLnByb2ZpbGVQaWN0dXJlIHx8IGNvbnRhY3ROYW1lKSB7XG4gICAgICAgICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgICAgICAgIGV2ZW50OiAnY29udGFjdC5tZXRhZGF0YScsXG4gICAgICAgICAgICAgIHNlc3Npb25JZCxcbiAgICAgICAgICAgICAgaW5zdGFuY2VOYW1lLFxuICAgICAgICAgICAgICBkYXRhOiB7XG4gICAgICAgICAgICAgICAgamlkLFxuICAgICAgICAgICAgICAgIHBob25lOiBqaWQuc3BsaXQoJ0AnKVswXS5yZXBsYWNlKC9cXEQvZywgJycpLFxuICAgICAgICAgICAgICAgIG5hbWU6IGNvbnRhY3ROYW1lLFxuICAgICAgICAgICAgICAgIHByb2ZpbGVQaWN0dXJlOiBtZXRhZGF0YS5wcm9maWxlUGljdHVyZSxcbiAgICAgICAgICAgICAgICBpc0dyb3VwLFxuICAgICAgICAgICAgICAgIGdyb3VwU3ViamVjdDogaXNHcm91cCA/IGNvbnRhY3ROYW1lIDogbnVsbCxcbiAgICAgICAgICAgICAgICBncm91cERlc2NyaXB0aW9uOiBtZXRhZGF0YS5ncm91cERlc2NyaXB0aW9uLFxuICAgICAgICAgICAgICAgIGdyb3VwUGFydGljaXBhbnRzOiBtZXRhZGF0YS5ncm91cFBhcnRpY2lwYW50c1xuICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgXG4gICAgICAgICAgcHJvY2Vzc2VkKys7XG4gICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAvLyBTaWxlbmNpYXIgZXJyb3MgaW5kaXZpZHVhaXNcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgXG4gICAgICAvLyBEZWxheSBlbnRyZSBiYXRjaGVzIHBhcmEgbsOjbyBzb2JyZWNhcnJlZ2FyXG4gICAgICBpZiAoaSArIEJBVENIX1NJWkUgPCBjaGF0cy5sZW5ndGgpIHtcbiAgICAgICAgYXdhaXQgZGVsYXkoMzAwKTtcbiAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgY29uc29sZS5sb2coYOKchSBNZXRhZGFkb3Mgc2luY3Jvbml6YWRvczogJHtwcm9jZXNzZWR9LyR7Y2hhdHMubGVuZ3RofSBjaGF0c2ApO1xuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJybyBzeW5jIG1ldGFkYWRvczonLCBlLm1lc3NhZ2UpO1xuICB9XG59XG5cbi8vIFVwbG9hZCBtw61kaWEgcGFyYSBTdXBhYmFzZSBzdG9yYWdlXG5hc3luYyBmdW5jdGlvbiB1cGxvYWRNZWRpYVRvU3RvcmFnZShidWZmZXIsIHNlc3Npb25JZCwgbWVzc2FnZUlkLCBtZWRpYVR5cGUpIHtcbiAgaWYgKCFTVVBBQkFTRV9VUkwgfHwgIVNVUEFCQVNFX1NFUlZJQ0VfUk9MRV9LRVkgfHwgIWJ1ZmZlcikgcmV0dXJuIG51bGw7XG4gIFxuICB0cnkge1xuICAgIGNvbnN0IGV4dE1hcCA9IHtcbiAgICAgICdpbWFnZSc6ICdqcGcnLFxuICAgICAgJ3ZpZGVvJzogJ21wNCcsXG4gICAgICAnYXVkaW8nOiAnb2dnJyxcbiAgICAgICdwdHQnOiAnb2dnJyxcbiAgICAgICdkb2N1bWVudCc6ICdwZGYnLFxuICAgICAgJ3N0aWNrZXInOiAnd2VicCdcbiAgICB9O1xuICAgIGNvbnN0IGV4dCA9IGV4dE1hcFttZWRpYVR5cGVdIHx8ICdiaW4nO1xuICAgIGNvbnN0IGZpbGVOYW1lID0gYCR7c2Vzc2lvbklkfS8ke0RhdGUubm93KCl9XyR7bWVzc2FnZUlkfS4ke2V4dH1gO1xuICAgIFxuICAgIGNvbnN0IHVwbG9hZFJlc3BvbnNlID0gYXdhaXQgZmV0Y2goXG4gICAgICBgJHtTVVBBQkFTRV9VUkx9L3N0b3JhZ2UvdjEvb2JqZWN0L3doYXRzYXBwLW1lZGlhLyR7ZmlsZU5hbWV9YCxcbiAgICAgIHtcbiAgICAgICAgbWV0aG9kOiAnUE9TVCcsXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAnQXV0aG9yaXphdGlvbic6IGBCZWFyZXIgJHtTVVBBQkFTRV9TRVJWSUNFX1JPTEVfS0VZfWAsXG4gICAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9vY3RldC1zdHJlYW0nXG4gICAgICAgIH0sXG4gICAgICAgIGJvZHk6IGJ1ZmZlclxuICAgICAgfVxuICAgICk7XG5cbiAgICBpZiAodXBsb2FkUmVzcG9uc2Uub2spIHtcbiAgICAgIHJldHVybiBgJHtTVVBBQkFTRV9VUkx9L3N0b3JhZ2UvdjEvb2JqZWN0L3B1YmxpYy93aGF0c2FwcC1tZWRpYS8ke2ZpbGVOYW1lfWA7XG4gICAgfVxuICB9IGNhdGNoIChlKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJybyB1cGxvYWQgbcOtZGlhOicsIGUubWVzc2FnZSk7XG4gIH1cbiAgcmV0dXJuIG51bGw7XG59XG5cbi8vIEVudmlhciB3ZWJob29rIHZpYSBmZXRjaCBwdXJvXG5hc3luYyBmdW5jdGlvbiBzZW5kV2ViaG9vayhwYXlsb2FkLCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0KSB7XG4gIGlmICghd2ViaG9va1VybCkgcmV0dXJuO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBmZXRjaCh3ZWJob29rVXJsLCB7XG4gICAgICBtZXRob2Q6ICdQT1NUJyxcbiAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgJ0NvbnRlbnQtVHlwZSc6ICdhcHBsaWNhdGlvbi9qc29uJyxcbiAgICAgICAgJ3gtd2ViaG9vay1zZWNyZXQnOiB3ZWJob29rU2VjcmV0IHx8ICcnXG4gICAgICB9LFxuICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkocGF5bG9hZClcbiAgICB9KTtcbiAgICBcbiAgICBpZiAoIXJlc3BvbnNlLm9rKSB7XG4gICAgICBjb25zb2xlLmVycm9yKCdXZWJob29rIGVycm9yOicsIHJlc3BvbnNlLnN0YXR1cyk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ1dlYmhvb2sgZmV0Y2ggZXJyb3I6JywgZXJyb3IubWVzc2FnZSk7XG4gIH1cbn1cblxuLy8gQ3JpYXIgc2Vzc8OjbyBXaGF0c0FwcFxuYXN5bmMgZnVuY3Rpb24gY3JlYXRlU2Vzc2lvbihjb25maWcpIHtcbiAgY29uc3QgeyBzZXNzaW9uSWQsIGluc3RhbmNlTmFtZSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCB9ID0gY29uZmlnO1xuICBcbiAgaWYgKHNlc3Npb25zLmhhcyhzZXNzaW9uSWQpKSB7XG4gICAgY29uc29sZS5sb2coYFNlc3PDo28gJHtpbnN0YW5jZU5hbWV9IGrDoSBleGlzdGVgKTtcbiAgICByZXR1cm4gc2Vzc2lvbnMuZ2V0KHNlc3Npb25JZCk7XG4gIH1cblxuICBjb25zdCBzZXNzaW9uUGF0aCA9IHBhdGguam9pbihfX2Rpcm5hbWUsICdzZXNzaW9ucycsIGluc3RhbmNlTmFtZSk7XG4gIFxuICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKF9fZGlybmFtZSwgJ3Nlc3Npb25zJykpKSB7XG4gICAgZnMubWtkaXJTeW5jKHBhdGguam9pbihfX2Rpcm5hbWUsICdzZXNzaW9ucycpLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxuXG4gIGNvbnN0IHsgc3RhdGUsIHNhdmVDcmVkcyB9ID0gYXdhaXQgdXNlTXVsdGlGaWxlQXV0aFN0YXRlKHNlc3Npb25QYXRoKTtcbiAgY29uc3QgeyB2ZXJzaW9uIH0gPSBhd2FpdCBmZXRjaExhdGVzdEJhaWxleXNWZXJzaW9uKCk7XG4gIFxuICBjb25zb2xlLmxvZyhg8J+TsSBDcmlhbmRvIHNlc3PDo286ICR7aW5zdGFuY2VOYW1lfSAoQmFpbGV5cyB2JHt2ZXJzaW9uLmpvaW4oJy4nKX0pYCk7XG5cbiAgY29uc3Qgc2Vzc2lvbiA9IHtcbiAgICBzZXNzaW9uSWQsXG4gICAgaW5zdGFuY2VOYW1lLFxuICAgIHNvY2tldDogbnVsbCxcbiAgICB3ZWJob29rVXJsLFxuICAgIHdlYmhvb2tTZWNyZXQsXG4gICAgcXJDb2RlOiBudWxsLFxuICAgIGlzQ29ubmVjdGVkOiBmYWxzZSxcbiAgICBwaG9uZU51bWJlcjogbnVsbCxcbiAgICBwdXNoTmFtZTogbnVsbCxcbiAgICBwcm9maWxlUGljdHVyZTogbnVsbCxcbiAgICByZWNvbm5lY3RBdHRlbXB0czogMCxcbiAgICBtYXhSZWNvbm5lY3RBdHRlbXB0czogMTAsXG4gICAgYWxsQ29udGFjdHM6IG5ldyBNYXAoKSxcbiAgICBhbGxDaGF0czogbmV3IE1hcCgpXG4gIH07XG5cbiAgc2Vzc2lvbnMuc2V0KHNlc3Npb25JZCwgc2Vzc2lvbik7XG5cbiAgY29uc3Qgc29ja2V0ID0gbWFrZVdBU29ja2V0KHtcbiAgICB2ZXJzaW9uLFxuICAgIGxvZ2dlcixcbiAgICBwcmludFFSSW5UZXJtaW5hbDogdHJ1ZSxcbiAgICBhdXRoOiB7XG4gICAgICBjcmVkczogc3RhdGUuY3JlZHMsXG4gICAgICBrZXlzOiBtYWtlQ2FjaGVhYmxlU2lnbmFsS2V5U3RvcmUoc3RhdGUua2V5cywgbG9nZ2VyKVxuICAgIH0sXG4gICAgYnJvd3NlcjogWydMb3ZhYmxlIENSTScsICdDaHJvbWUnLCAnMTIwLjAuMCddLFxuICAgIGNvbm5lY3RUaW1lb3V0TXM6IDYwMDAwLFxuICAgIHFyVGltZW91dDogNjAwMDAsXG4gICAgZGVmYXVsdFF1ZXJ5VGltZW91dE1zOiA2MDAwMCxcbiAgICBrZWVwQWxpdmVJbnRlcnZhbE1zOiAyMDAwMCxcbiAgICBzeW5jRnVsbEhpc3Rvcnk6IHRydWVcbiAgfSk7XG5cbiAgc2Vzc2lvbi5zb2NrZXQgPSBzb2NrZXQ7XG5cbiAgLy8gU2FsdmFyIGNyZWRlbmNpYWlzXG4gIHNvY2tldC5ldi5vbignY3JlZHMudXBkYXRlJywgc2F2ZUNyZWRzKTtcblxuICAvLyBBdHVhbGl6YcOnw7VlcyBkZSBjb25leMOjb1xuICBzb2NrZXQuZXYub24oJ2Nvbm5lY3Rpb24udXBkYXRlJywgYXN5bmMgKHVwZGF0ZSkgPT4ge1xuICAgIGNvbnN0IHsgcXIsIGNvbm5lY3Rpb24sIGxhc3REaXNjb25uZWN0IH0gPSB1cGRhdGU7XG5cbiAgICBpZiAocXIpIHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IHFyRGF0YVVybCA9IGF3YWl0IFFSQ29kZS50b0RhdGFVUkwocXIpO1xuICAgICAgICBzZXNzaW9uLnFyQ29kZSA9IHFyRGF0YVVybDtcbiAgICAgICAgXG4gICAgICAgIGF3YWl0IHNlbmRXZWJob29rKHtcbiAgICAgICAgICBldmVudDogJ3FyLnVwZGF0ZScsXG4gICAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICAgIGluc3RhbmNlTmFtZSxcbiAgICAgICAgICBkYXRhOiB7IHFyQ29kZTogcXJEYXRhVXJsIH1cbiAgICAgICAgfSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCk7XG4gICAgICAgIFxuICAgICAgICBjb25zb2xlLmxvZyhg8J+TsSBRUiBDb2RlIGdlcmFkbyBwYXJhICR7aW5zdGFuY2VOYW1lfWApO1xuICAgICAgfSBjYXRjaCAocXJFcnJvcikge1xuICAgICAgICBjb25zb2xlLmVycm9yKCdFcnJvIGFvIGdlcmFyIFFSIENvZGU6JywgcXJFcnJvci5tZXNzYWdlKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoY29ubmVjdGlvbiA9PT0gJ29wZW4nKSB7XG4gICAgICBzZXNzaW9uLmlzQ29ubmVjdGVkID0gdHJ1ZTtcbiAgICAgIHNlc3Npb24ucXJDb2RlID0gbnVsbDtcbiAgICAgIHNlc3Npb24ucmVjb25uZWN0QXR0ZW1wdHMgPSAwO1xuICAgICAgXG4gICAgICBjb25zdCB1c2VyID0gc29ja2V0LnVzZXI7XG4gICAgICBpZiAodXNlcikge1xuICAgICAgICBzZXNzaW9uLnBob25lTnVtYmVyID0gdXNlci5pZC5zcGxpdCgnOicpWzBdLnJlcGxhY2UoJ0BzLndoYXRzYXBwLm5ldCcsICcnKTtcbiAgICAgICAgc2Vzc2lvbi5wdXNoTmFtZSA9IHVzZXIubmFtZSB8fCB1c2VyLm5vdGlmeSB8fCBudWxsO1xuICAgICAgICBcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBzZXNzaW9uLnByb2ZpbGVQaWN0dXJlID0gYXdhaXQgc29ja2V0LnByb2ZpbGVQaWN0dXJlVXJsKHVzZXIuaWQsICdpbWFnZScpO1xuICAgICAgICB9IGNhdGNoIChlKSB7fVxuICAgICAgfVxuICAgICAgXG4gICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgIGV2ZW50OiAnY29ubmVjdGlvbi51cGRhdGUnLFxuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIGluc3RhbmNlTmFtZSxcbiAgICAgICAgZGF0YToge1xuICAgICAgICAgIGNvbm5lY3Rpb246ICdvcGVuJyxcbiAgICAgICAgICBpc0Nvbm5lY3RlZDogdHJ1ZSxcbiAgICAgICAgICBwaG9uZU51bWJlcjogc2Vzc2lvbi5waG9uZU51bWJlcixcbiAgICAgICAgICBwdXNoTmFtZTogc2Vzc2lvbi5wdXNoTmFtZSxcbiAgICAgICAgICBwcm9maWxlUGljdHVyZTogc2Vzc2lvbi5wcm9maWxlUGljdHVyZVxuICAgICAgICB9XG4gICAgICB9LCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0KTtcbiAgICAgIFxuICAgICAgY29uc29sZS5sb2coYOKchSAke2luc3RhbmNlTmFtZX0gY29uZWN0YWRvIWApO1xuICAgICAgXG4gICAgICAvLyA9PT09PSB2NC42LjA6IFNZTkMgUFJPQVRJVk8gREUgTUVUQURBRE9TIEFQw5NTIENPTkVYw4NPID09PT09XG4gICAgICAvLyBBZ3VhcmRhciAzcyBwYXJhIGVzdGFiaWxpemFyLCBkZXBvaXMgYnVzY2FyIGZvdG9zIGUgbm9tZXMgcGFyYSBUT0RPUyBvcyBjaGF0c1xuICAgICAgc2V0VGltZW91dChhc3luYyAoKSA9PiB7XG4gICAgICAgIGNvbnNvbGUubG9nKGDwn5O4IEluaWNpYW5kbyBzeW5jIHByb2F0aXZvIGRlIG1ldGFkYWRvcyBwYXJhICR7aW5zdGFuY2VOYW1lfS4uLmApO1xuICAgICAgICBhd2FpdCBzeW5jQWxsTWV0YWRhdGEoc29ja2V0LCBzZXNzaW9uLCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0LCBzZXNzaW9uSWQsIGluc3RhbmNlTmFtZSk7XG4gICAgICB9LCAzMDAwKTtcbiAgICB9XG5cbiAgICBpZiAoY29ubmVjdGlvbiA9PT0gJ2Nsb3NlJykge1xuICAgICAgc2Vzc2lvbi5pc0Nvbm5lY3RlZCA9IGZhbHNlO1xuICAgICAgY29uc3Qgc3RhdHVzQ29kZSA9IGxhc3REaXNjb25uZWN0Py5lcnJvcj8ub3V0cHV0Py5zdGF0dXNDb2RlO1xuICAgICAgY29uc3Qgc2hvdWxkUmVjb25uZWN0ID0gc3RhdHVzQ29kZSAhPT0gRGlzY29ubmVjdFJlYXNvbi5sb2dnZWRPdXQ7XG4gICAgICBcbiAgICAgIGNvbnNvbGUubG9nKGDinYwgJHtpbnN0YW5jZU5hbWV9IGRlc2NvbmVjdGFkby4gQ8OzZGlnbzogJHtzdGF0dXNDb2RlfWApO1xuICAgICAgXG4gICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgIGV2ZW50OiAnY29ubmVjdGlvbi51cGRhdGUnLFxuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIGluc3RhbmNlTmFtZSxcbiAgICAgICAgZGF0YToge1xuICAgICAgICAgIGNvbm5lY3Rpb246ICdjbG9zZScsXG4gICAgICAgICAgaXNDb25uZWN0ZWQ6IGZhbHNlLFxuICAgICAgICAgIHN0YXR1c0NvZGUsXG4gICAgICAgICAgc2hvdWxkUmVjb25uZWN0XG4gICAgICAgIH1cbiAgICAgIH0sIHdlYmhvb2tVcmwsIHdlYmhvb2tTZWNyZXQpO1xuXG4gICAgICBpZiAoc2hvdWxkUmVjb25uZWN0ICYmIHNlc3Npb24ucmVjb25uZWN0QXR0ZW1wdHMgPCBzZXNzaW9uLm1heFJlY29ubmVjdEF0dGVtcHRzKSB7XG4gICAgICAgIHNlc3Npb24ucmVjb25uZWN0QXR0ZW1wdHMrKztcbiAgICAgICAgY29uc3QgcmVjb25uZWN0RGVsYXkgPSBNYXRoLm1pbig1MDAwICogTWF0aC5wb3coMS41LCBzZXNzaW9uLnJlY29ubmVjdEF0dGVtcHRzIC0gMSksIDYwMDAwKTtcbiAgICAgICAgY29uc29sZS5sb2coYPCflIQgUmVjb25lY3RhbmRvIGVtICR7cmVjb25uZWN0RGVsYXkvMTAwMH1zYCk7XG4gICAgICAgIFxuICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgICBzZXNzaW9ucy5kZWxldGUoc2Vzc2lvbklkKTtcbiAgICAgICAgICBjcmVhdGVTZXNzaW9uKGNvbmZpZyk7XG4gICAgICAgIH0sIHJlY29ubmVjdERlbGF5KTtcbiAgICAgIH0gZWxzZSBpZiAoc3RhdHVzQ29kZSA9PT0gRGlzY29ubmVjdFJlYXNvbi5sb2dnZWRPdXQpIHtcbiAgICAgICAgc2Vzc2lvbnMuZGVsZXRlKHNlc3Npb25JZCk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcblxuICAvLyA9PT09PSBTWU5DIENPTVBMRVRPIERFIENPTlRBVE9TID09PT09XG4gIHNvY2tldC5ldi5vbignY29udGFjdHMuc2V0JywgYXN5bmMgKHsgY29udGFjdHMgfSkgPT4ge1xuICAgIGNvbnNvbGUubG9nKGDwn5OHIGNvbnRhY3RzLnNldDogJHtjb250YWN0cy5sZW5ndGh9IGNvbnRhdG9zIHJlY2ViaWRvc2ApO1xuICAgIFxuICAgIC8vIEFybWF6ZW5hIG5vIGNhY2hlIGRhIHNlc3PDo28gZSBubyBjYWNoZSBnbG9iYWwgZGUgbm9tZXNcbiAgICBmb3IgKGNvbnN0IGNvbnRhY3Qgb2YgY29udGFjdHMpIHtcbiAgICAgIGNvbnN0IGppZCA9IGNvbnRhY3QuaWQgfHwgY29udGFjdC5qaWQ7XG4gICAgICBpZiAoamlkKSB7XG4gICAgICAgIHNlc3Npb24uYWxsQ29udGFjdHMuc2V0KGppZCwgY29udGFjdCk7XG4gICAgICAgIC8vIENhY2hlIG5vbWUgcGFyYSB1c28gZW0gbWVuc2FnZW5zXG4gICAgICAgIGNvbnN0IG5hbWUgPSBjb250YWN0Lm5hbWUgfHwgY29udGFjdC5ub3RpZnkgfHwgY29udGFjdC5wdXNoTmFtZSB8fCBjb250YWN0LnZlcmlmaWVkTmFtZTtcbiAgICAgICAgaWYgKG5hbWUpIHtcbiAgICAgICAgICBjb250YWN0TmFtZXNDYWNoZS5zZXQoamlkLCBuYW1lKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvLyBFbnZpYSBlbSBiYXRjaGVzIHBhcmEgZXZpdGFyIHRpbWVvdXRcbiAgICBjb25zdCBCQVRDSF9TSVpFID0gNTA7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjb250YWN0cy5sZW5ndGg7IGkgKz0gQkFUQ0hfU0laRSkge1xuICAgICAgY29uc3QgYmF0Y2ggPSBjb250YWN0cy5zbGljZShpLCBpICsgQkFUQ0hfU0laRSk7XG4gICAgICBcbiAgICAgIGF3YWl0IHNlbmRXZWJob29rKHtcbiAgICAgICAgZXZlbnQ6ICdjb250YWN0cy5zZXQnLFxuICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgIGluc3RhbmNlTmFtZSxcbiAgICAgICAgZGF0YTogeyBcbiAgICAgICAgICBjb250YWN0czogYmF0Y2gsXG4gICAgICAgICAgYmF0Y2g6IE1hdGguZmxvb3IoaSAvIEJBVENIX1NJWkUpICsgMSxcbiAgICAgICAgICB0b3RhbEJhdGNoZXM6IE1hdGguY2VpbChjb250YWN0cy5sZW5ndGggLyBCQVRDSF9TSVpFKSxcbiAgICAgICAgICB0b3RhbENvbnRhY3RzOiBjb250YWN0cy5sZW5ndGhcbiAgICAgICAgfVxuICAgICAgfSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCk7XG4gICAgICBcbiAgICAgIGlmIChpICsgQkFUQ0hfU0laRSA8IGNvbnRhY3RzLmxlbmd0aCkge1xuICAgICAgICBhd2FpdCBkZWxheSgyMDApO1xuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBjb25zb2xlLmxvZyhg4pyFIFRvZG9zIG9zICR7Y29udGFjdHMubGVuZ3RofSBjb250YXRvcyBlbnZpYWRvc2ApO1xuICB9KTtcblxuICBzb2NrZXQuZXYub24oJ2NvbnRhY3RzLnVwc2VydCcsIGFzeW5jIChjb250YWN0cykgPT4ge1xuICAgIGNvbnNvbGUubG9nKGDwn5OHIGNvbnRhY3RzLnVwc2VydDogJHtjb250YWN0cy5sZW5ndGh9IGNvbnRhdG9zYCk7XG4gICAgXG4gICAgZm9yIChjb25zdCBjb250YWN0IG9mIGNvbnRhY3RzKSB7XG4gICAgICBjb25zdCBqaWQgPSBjb250YWN0LmlkIHx8IGNvbnRhY3QuamlkO1xuICAgICAgaWYgKGppZCkge1xuICAgICAgICBzZXNzaW9uLmFsbENvbnRhY3RzLnNldChqaWQsIGNvbnRhY3QpO1xuICAgICAgICBjb25zdCBuYW1lID0gY29udGFjdC5uYW1lIHx8IGNvbnRhY3Qubm90aWZ5IHx8IGNvbnRhY3QucHVzaE5hbWUgfHwgY29udGFjdC52ZXJpZmllZE5hbWU7XG4gICAgICAgIGlmIChuYW1lKSB7XG4gICAgICAgICAgY29udGFjdE5hbWVzQ2FjaGUuc2V0KGppZCwgbmFtZSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgYXdhaXQgc2VuZFdlYmhvb2soe1xuICAgICAgZXZlbnQ6ICdjb250YWN0cy51cHNlcnQnLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgaW5zdGFuY2VOYW1lLFxuICAgICAgZGF0YTogeyBjb250YWN0cyB9XG4gICAgfSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCk7XG4gIH0pO1xuXG4gIC8vID09PT09IFNZTkMgQ09NUExFVE8gREUgQ0hBVFMgPT09PT1cbiAgc29ja2V0LmV2Lm9uKCdjaGF0cy5zZXQnLCBhc3luYyAoeyBjaGF0cyB9KSA9PiB7XG4gICAgY29uc29sZS5sb2coYPCfkqwgY2hhdHMuc2V0OiAke2NoYXRzLmxlbmd0aH0gY2hhdHMgcmVjZWJpZG9zYCk7XG4gICAgXG4gICAgZm9yIChjb25zdCBjaGF0IG9mIGNoYXRzKSB7XG4gICAgICBjb25zdCBqaWQgPSBjaGF0LmlkIHx8IGNoYXQuamlkO1xuICAgICAgaWYgKGppZCkge1xuICAgICAgICBzZXNzaW9uLmFsbENoYXRzLnNldChqaWQsIGNoYXQpO1xuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICAvLyBFbnJpcXVlY2UgY2hhdHMgZW0gYmF0Y2hlc1xuICAgIGNvbnN0IEJBVENIX1NJWkUgPSAzMDtcbiAgICBjb25zdCBlbnJpY2hlZENoYXRzID0gW107XG4gICAgXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjaGF0cy5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgY2hhdCA9IGNoYXRzW2ldO1xuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgamlkID0gY2hhdD8uaWQgfHwgY2hhdD8uamlkO1xuICAgICAgICBpZiAoIWppZCB8fCBqaWQgPT09ICdzdGF0dXNAYnJvYWRjYXN0JykgY29udGludWU7XG5cbiAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IGZldGNoQ29udGFjdE1ldGFkYXRhKHNvY2tldCwgamlkKTtcbiAgICAgICAgY29uc3QgaXNHcm91cCA9IGppZC5lbmRzV2l0aCgnQGcudXMnKTtcblxuICAgICAgICAvLyA9PT09PSB2NC41LjA6IE1lbGhvciBleHRyYcOnw6NvIGRlIG5vbWVzID09PT09XG4gICAgICAgIGxldCBjb250YWN0TmFtZSA9IG51bGw7XG4gICAgICAgIGlmIChpc0dyb3VwKSB7XG4gICAgICAgICAgLy8gR3J1cG9zOiBwcmlvcmlkYWRlIHBhcmEgbWV0YWRhZG9zIGRvIGdydXBvXG4gICAgICAgICAgY29udGFjdE5hbWUgPSBtZXRhLmdyb3VwU3ViamVjdCB8fCBjaGF0LnN1YmplY3QgfHwgY2hhdC5ncm91cFN1YmplY3QgfHwgY2hhdC5uYW1lIHx8IG51bGw7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gQ29udGF0b3MgaW5kaXZpZHVhaXM6IGJ1c2NhciBkbyBjYWNoZSBvdSBjaGF0XG4gICAgICAgICAgY29udGFjdE5hbWUgPSBjb250YWN0TmFtZXNDYWNoZS5nZXQoamlkKSB8fCBjaGF0Lm5hbWUgfHwgY2hhdC5ub3RpZnkgfHwgY2hhdC5wdXNoTmFtZSB8fCBjaGF0LnZlcmlmaWVkTmFtZSB8fCBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgZW5yaWNoZWQgPSB7XG4gICAgICAgICAgLi4uY2hhdCxcbiAgICAgICAgICBpZDogamlkLFxuICAgICAgICAgIGppZCxcbiAgICAgICAgICBuYW1lOiBjb250YWN0TmFtZSxcbiAgICAgICAgICBjb250YWN0TmFtZSxcbiAgICAgICAgICBwcm9maWxlUGljdHVyZTogbWV0YS5wcm9maWxlUGljdHVyZSB8fCBjaGF0LnByb2ZpbGVQaWN0dXJlIHx8IGNoYXQuaW1nVXJsIHx8IG51bGwsXG4gICAgICAgIH07XG5cbiAgICAgICAgaWYgKGlzR3JvdXApIHtcbiAgICAgICAgICBlbnJpY2hlZC5ncm91cFN1YmplY3QgPSBjb250YWN0TmFtZTtcbiAgICAgICAgICBlbnJpY2hlZC5tZXRhZGF0YSA9IHtcbiAgICAgICAgICAgIC4uLihjaGF0Lm1ldGFkYXRhIHx8IHt9KSxcbiAgICAgICAgICAgIHN1YmplY3Q6IGNvbnRhY3ROYW1lLFxuICAgICAgICAgICAgZGVzYzogbWV0YS5ncm91cERlc2NyaXB0aW9uIHx8IG51bGwsXG4gICAgICAgICAgICBwYXJ0aWNpcGFudHM6IG1ldGEuZ3JvdXBQYXJ0aWNpcGFudHMgfHwgbnVsbCxcbiAgICAgICAgICB9O1xuICAgICAgICB9XG5cbiAgICAgICAgZW5yaWNoZWRDaGF0cy5wdXNoKGVucmljaGVkKTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpICUgMTAgPT09IDAgJiYgaSA+IDApIHtcbiAgICAgICAgICBhd2FpdCBkZWxheSgxMDApO1xuICAgICAgICB9XG4gICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIGNvbnNvbGUubG9nKCdFcnJvIGFvIGVucmlxdWVjZXIgY2hhdDonLCBlPy5tZXNzYWdlIHx8IGUpO1xuICAgICAgfVxuICAgICAgXG4gICAgICBpZiAoZW5yaWNoZWRDaGF0cy5sZW5ndGggPj0gQkFUQ0hfU0laRSB8fCBpID09PSBjaGF0cy5sZW5ndGggLSAxKSB7XG4gICAgICAgIGlmIChlbnJpY2hlZENoYXRzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgICAgICBldmVudDogJ2NoYXRzLnNldCcsXG4gICAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgICBpbnN0YW5jZU5hbWUsXG4gICAgICAgICAgICBkYXRhOiB7IFxuICAgICAgICAgICAgICBjaGF0czogWy4uLmVucmljaGVkQ2hhdHNdLFxuICAgICAgICAgICAgICBiYXRjaDogTWF0aC5mbG9vcihpIC8gQkFUQ0hfU0laRSkgKyAxLFxuICAgICAgICAgICAgICB0b3RhbENoYXRzOiBjaGF0cy5sZW5ndGhcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9LCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0KTtcbiAgICAgICAgICBcbiAgICAgICAgICBlbnJpY2hlZENoYXRzLmxlbmd0aCA9IDA7XG4gICAgICAgICAgYXdhaXQgZGVsYXkoMTUwKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBjb25zb2xlLmxvZyhg4pyFIFRvZG9zIG9zICR7Y2hhdHMubGVuZ3RofSBjaGF0cyBwcm9jZXNzYWRvc2ApO1xuICB9KTtcblxuICBzb2NrZXQuZXYub24oJ2NoYXRzLnVwc2VydCcsIGFzeW5jIChjaGF0cykgPT4ge1xuICAgIGNvbnNvbGUubG9nKGDwn5KsIGNoYXRzLnVwc2VydDogJHtjaGF0cy5sZW5ndGh9IGNoYXRzYCk7XG4gICAgXG4gICAgZm9yIChjb25zdCBjaGF0IG9mIGNoYXRzKSB7XG4gICAgICBjb25zdCBqaWQgPSBjaGF0LmlkIHx8IGNoYXQuamlkO1xuICAgICAgaWYgKGppZCkge1xuICAgICAgICBzZXNzaW9uLmFsbENoYXRzLnNldChqaWQsIGNoYXQpO1xuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICBldmVudDogJ2NoYXRzLnVwc2VydCcsXG4gICAgICBzZXNzaW9uSWQsXG4gICAgICBpbnN0YW5jZU5hbWUsXG4gICAgICBkYXRhOiB7IGNoYXRzIH1cbiAgICB9LCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0KTtcbiAgfSk7XG5cbiAgLy8gPT09PT0gSElTVMOTUklDTyBERSBNRU5TQUdFTlMgLSA2IEhPUkFTID09PT09XG4gIHNvY2tldC5ldi5vbignbWVzc2FnaW5nLWhpc3Rvcnkuc2V0JywgYXN5bmMgKHsgY2hhdHMgPSBbXSwgY29udGFjdHMgPSBbXSwgbWVzc2FnZXMgPSBbXSwgaXNMYXRlc3QgfSkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zb2xlLmxvZyhg8J+TpSBIaXN0b3J5IHNldDogY2hhdHM9JHtjaGF0cy5sZW5ndGh9IGNvbnRhY3RzPSR7Y29udGFjdHMubGVuZ3RofSBtZXNzYWdlcz0ke21lc3NhZ2VzLmxlbmd0aH0gbGF0ZXN0PSR7aXNMYXRlc3R9YCk7XG5cbiAgICAgIC8vIFByb2Nlc3NhIGNvbnRhdG9zIGFkaWNpb25haXMgZG8gaGlzdMOzcmljb1xuICAgICAgaWYgKGNvbnRhY3RzICYmIGNvbnRhY3RzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgZm9yIChjb25zdCBjb250YWN0IG9mIGNvbnRhY3RzKSB7XG4gICAgICAgICAgY29uc3QgamlkID0gY29udGFjdC5pZCB8fCBjb250YWN0LmppZDtcbiAgICAgICAgICBpZiAoamlkKSB7XG4gICAgICAgICAgICBzZXNzaW9uLmFsbENvbnRhY3RzLnNldChqaWQsIGNvbnRhY3QpO1xuICAgICAgICAgICAgY29uc3QgbmFtZSA9IGNvbnRhY3QubmFtZSB8fCBjb250YWN0Lm5vdGlmeSB8fCBjb250YWN0LnB1c2hOYW1lIHx8IGNvbnRhY3QudmVyaWZpZWROYW1lO1xuICAgICAgICAgICAgaWYgKG5hbWUpIHtcbiAgICAgICAgICAgICAgY29udGFjdE5hbWVzQ2FjaGUuc2V0KGppZCwgbmFtZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBjb25zdCBCQVRDSF9TSVpFID0gNTA7XG4gICAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY29udGFjdHMubGVuZ3RoOyBpICs9IEJBVENIX1NJWkUpIHtcbiAgICAgICAgICBjb25zdCBiYXRjaCA9IGNvbnRhY3RzLnNsaWNlKGksIGkgKyBCQVRDSF9TSVpFKTtcbiAgICAgICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgICAgICBldmVudDogJ2NvbnRhY3RzLnNldCcsXG4gICAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgICBpbnN0YW5jZU5hbWUsXG4gICAgICAgICAgICBkYXRhOiB7IGNvbnRhY3RzOiBiYXRjaCB9XG4gICAgICAgICAgfSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCk7XG4gICAgICAgICAgYXdhaXQgZGVsYXkoMTAwKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyA9PT09PSBQcm9jZXNzYSBtZW5zYWdlbnMgZGFzIMO6bHRpbWFzIDYgSE9SQVMgPT09PT1cbiAgICAgIGNvbnN0IFNJWF9IT1VSU19NUyA9IDYgKiA2MCAqIDYwICogMTAwMDtcbiAgICAgIGNvbnN0IGN1dG9mZiA9IERhdGUubm93KCkgLSBTSVhfSE9VUlNfTVM7XG5cbiAgICAgIGNvbnN0IHRvTXMgPSAodHMpID0+IHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBpZiAoIXRzKSByZXR1cm4gbnVsbDtcbiAgICAgICAgICBpZiAodHlwZW9mIHRzID09PSAnbnVtYmVyJykgcmV0dXJuIHRzID4gNDEwMjQ0NDgwMCA/IHRzIDogdHMgKiAxMDAwO1xuICAgICAgICAgIGlmICh0eXBlb2YgdHMgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICBjb25zdCBuID0gcGFyc2VJbnQodHMsIDEwKTtcbiAgICAgICAgICAgIGlmICghaXNOYU4obikpIHJldHVybiBuID4gNDEwMjQ0NDgwMCA/IG4gOiBuICogMTAwMDtcbiAgICAgICAgICB9XG4gICAgICAgICAgaWYgKHR5cGVvZiB0cyA9PT0gJ29iamVjdCcgJiYgdHMgIT09IG51bGwpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2YgdHMubG93ID09PSAnbnVtYmVyJykgcmV0dXJuIHRzLmxvdyAqIDEwMDA7XG4gICAgICAgICAgICBpZiAodHlwZW9mIHRzLnRvTnVtYmVyID09PSAnZnVuY3Rpb24nKSByZXR1cm4gdHMudG9OdW1iZXIoKSAqIDEwMDA7XG4gICAgICAgICAgfVxuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9IGNhdGNoIHtcbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuICAgICAgfTtcblxuICAgICAgY29uc3QgcmVjZW50ID0gKG1lc3NhZ2VzIHx8IFtdKS5maWx0ZXIoKG0pID0+IHtcbiAgICAgICAgY29uc3QgbXMgPSB0b01zKG0/Lm1lc3NhZ2VUaW1lc3RhbXApO1xuICAgICAgICByZXR1cm4gbXMgJiYgbXMgPj0gY3V0b2ZmO1xuICAgICAgfSk7XG5cbiAgICAgIGNvbnNvbGUubG9nKGDwn5OoIFByb2Nlc3NhbmRvICR7cmVjZW50Lmxlbmd0aH0gbWVuc2FnZW5zIHJlY2VudGVzICjDumx0aW1hcyA2aClgKTtcblxuICAgICAgY29uc3QgQkFUQ0ggPSAyMDtcbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgcmVjZW50Lmxlbmd0aDsgaSArPSBCQVRDSCkge1xuICAgICAgICBjb25zdCBzbGljZSA9IHJlY2VudC5zbGljZShpLCBpICsgQkFUQ0gpO1xuXG4gICAgICAgIGNvbnN0IG1hcHBlZCA9IFtdO1xuICAgICAgICBmb3IgKGNvbnN0IG0gb2Ygc2xpY2UpIHtcbiAgICAgICAgICBjb25zdCBqaWQgPSBtPy5rZXk/LnJlbW90ZUppZDtcbiAgICAgICAgICBpZiAoIWppZCB8fCBqaWQgPT09ICdzdGF0dXNAYnJvYWRjYXN0JykgY29udGludWU7XG5cbiAgICAgICAgICBjb25zdCBpc0dyb3VwID0gamlkLmVuZHNXaXRoKCdAZy51cycpO1xuICAgICAgICAgIGNvbnN0IHBhcnRpY2lwYW50ID0gbT8ua2V5Py5wYXJ0aWNpcGFudDtcblxuICAgICAgICAgIC8vID09PT09IHY0LjUuMDogTWVsaG9yIGV4dHJhw6fDo28gZGUgcmVtZXRlbnRlIGVtIGdydXBvcyA9PT09PVxuICAgICAgICAgIGxldCBzZW5kZXJQaG9uZSA9IG51bGw7XG4gICAgICAgICAgbGV0IHNlbmRlck5hbWUgPSBudWxsO1xuICAgICAgICAgIFxuICAgICAgICAgIGlmIChpc0dyb3VwICYmIHBhcnRpY2lwYW50KSB7XG4gICAgICAgICAgICBzZW5kZXJQaG9uZSA9IHBhcnRpY2lwYW50LnNwbGl0KCdAJylbMF0ucmVwbGFjZSgvXFxEL2csICcnKTtcbiAgICAgICAgICAgIC8vIEJ1c2NhciBub21lIGRvIGNhY2hlIHByaW1laXJvLCBkZXBvaXMgcHVzaE5hbWVcbiAgICAgICAgICAgIHNlbmRlck5hbWUgPSBjb250YWN0TmFtZXNDYWNoZS5nZXQocGFydGljaXBhbnQpIHx8IG0/LnB1c2hOYW1lIHx8IG51bGw7XG4gICAgICAgICAgfVxuICAgICAgICAgIFxuICAgICAgICAgIC8vIFBhcmEgY29udGF0b3MgaW5kaXZpZHVhaXMgaW5jb21pbmcsIHVzYXIgcHVzaE5hbWVcbiAgICAgICAgICBpZiAoIWlzR3JvdXAgJiYgIW0/LmtleT8uZnJvbU1lKSB7XG4gICAgICAgICAgICBzZW5kZXJOYW1lID0gY29udGFjdE5hbWVzQ2FjaGUuZ2V0KGppZCkgfHwgbT8ucHVzaE5hbWUgfHwgbnVsbDtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICAvLyA9PT09PSB2NC41LjA6IERldGVjdGFyIHRpcG8gZGUgbcOtZGlhIGluY2x1aW5kbyBzdGlja2VyID09PT09XG4gICAgICAgICAgbGV0IG1lZGlhVHlwZSA9IG51bGw7XG4gICAgICAgICAgbGV0IG1lZGlhVXJsID0gbnVsbDtcbiAgICAgICAgICBjb25zdCBtc2dDb250ZW50ID0gbS5tZXNzYWdlO1xuICAgICAgICAgIFxuICAgICAgICAgIGlmIChtc2dDb250ZW50KSB7XG4gICAgICAgICAgICBpZiAobXNnQ29udGVudC5pbWFnZU1lc3NhZ2UpIG1lZGlhVHlwZSA9ICdpbWFnZSc7XG4gICAgICAgICAgICBlbHNlIGlmIChtc2dDb250ZW50LnZpZGVvTWVzc2FnZSkgbWVkaWFUeXBlID0gJ3ZpZGVvJztcbiAgICAgICAgICAgIGVsc2UgaWYgKG1zZ0NvbnRlbnQuYXVkaW9NZXNzYWdlKSB7XG4gICAgICAgICAgICAgIG1lZGlhVHlwZSA9IG1zZ0NvbnRlbnQuYXVkaW9NZXNzYWdlLnB0dCA/ICdwdHQnIDogJ2F1ZGlvJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGVsc2UgaWYgKG1zZ0NvbnRlbnQuZG9jdW1lbnRNZXNzYWdlKSBtZWRpYVR5cGUgPSAnZG9jdW1lbnQnO1xuICAgICAgICAgICAgZWxzZSBpZiAobXNnQ29udGVudC5zdGlja2VyTWVzc2FnZSkgbWVkaWFUeXBlID0gJ3N0aWNrZXInO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vID09PT09IHY0LjUuMDogRG93bmxvYWQgZGUgc3RpY2tlcnMgZSBvdXRyYXMgbcOtZGlhcyBkbyBoaXN0w7NyaWNvID09PT09XG4gICAgICAgICAgaWYgKG1lZGlhVHlwZSAmJiBTVVBBQkFTRV9VUkwgJiYgU1VQQUJBU0VfU0VSVklDRV9ST0xFX0tFWSkge1xuICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgYXdhaXQgYWNxdWlyZURvd25sb2FkKCk7XG4gICAgICAgICAgICAgIGNvbnN0IGJ1ZmZlciA9IGF3YWl0IGRvd25sb2FkTWVkaWFNZXNzYWdlKG0sICdidWZmZXInLCB7fSk7XG4gICAgICAgICAgICAgIGlmIChidWZmZXIpIHtcbiAgICAgICAgICAgICAgICBtZWRpYVVybCA9IGF3YWl0IHVwbG9hZE1lZGlhVG9TdG9yYWdlKGJ1ZmZlciwgc2Vzc2lvbklkLCBtLmtleS5pZCwgbWVkaWFUeXBlKTtcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICBjb25zb2xlLmVycm9yKGBFcnJvIGRvd25sb2FkIG3DrWRpYSAoJHttZWRpYVR5cGV9KTpgLCBlLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgICAgcmVsZWFzZURvd25sb2FkKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgbWFwcGVkLnB1c2goe1xuICAgICAgICAgICAga2V5OiBtLmtleSxcbiAgICAgICAgICAgIG1lc3NhZ2U6IG0ubWVzc2FnZSxcbiAgICAgICAgICAgIG1lc3NhZ2VUaW1lc3RhbXA6IG0ubWVzc2FnZVRpbWVzdGFtcCxcbiAgICAgICAgICAgIHB1c2hOYW1lOiBtLnB1c2hOYW1lLFxuICAgICAgICAgICAgc2VuZGVyUGhvbmUsXG4gICAgICAgICAgICBzZW5kZXJOYW1lLFxuICAgICAgICAgICAgbWVkaWFVcmwsXG4gICAgICAgICAgICBtZWRpYVR5cGUsXG4gICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobWFwcGVkLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgICAgICBldmVudDogJ21lc3NhZ2VzLnVwc2VydCcsXG4gICAgICAgICAgICBzZXNzaW9uSWQsXG4gICAgICAgICAgICBpbnN0YW5jZU5hbWUsXG4gICAgICAgICAgICBkYXRhOiB7IG1lc3NhZ2VzOiBtYXBwZWQgfVxuICAgICAgICAgIH0sIHdlYmhvb2tVcmwsIHdlYmhvb2tTZWNyZXQpO1xuICAgICAgICAgIGF3YWl0IGRlbGF5KDEwMCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgY29uc29sZS5sb2coYOKchSBTeW5jIGluaWNpYWwgY29uY2x1w61kbyAoJHtyZWNlbnQubGVuZ3RofSBtZW5zYWdlbnMgZGFzIMO6bHRpbWFzIDZoKWApO1xuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUubG9nKCfinYwgRXJybyBubyBzeW5jIGluaWNpYWw6JywgZT8ubWVzc2FnZSB8fCBlKTtcbiAgICB9XG4gIH0pO1xuXG4gIC8vID09PT09IE1FTlNBR0VOUyBSRUNFQklEQVMgRU0gVEVNUE8gUkVBTCA9PT09PVxuICBzb2NrZXQuZXYub24oJ21lc3NhZ2VzLnVwc2VydCcsIGFzeW5jICh7IG1lc3NhZ2VzLCB0eXBlIH0pID0+IHtcbiAgICBpZiAodHlwZSAhPT0gJ25vdGlmeScpIHJldHVybjtcblxuICAgIGZvciAoY29uc3QgbXNnIG9mIG1lc3NhZ2VzKSB7XG4gICAgICBpZiAobXNnLmtleS5yZW1vdGVKaWQgPT09ICdzdGF0dXNAYnJvYWRjYXN0JykgY29udGludWU7XG4gICAgICBcbiAgICAgIGNvbnN0IGppZCA9IG1zZy5rZXkucmVtb3RlSmlkO1xuICAgICAgY29uc29sZS5sb2coYPCfk6ggTWVuc2FnZW0gZGUgJHtqaWR9YCk7XG4gICAgICBcbiAgICAgIC8vIEJ1c2NhciBtZXRhZGFkb3NcbiAgICAgIGNvbnN0IG1ldGFkYXRhID0gYXdhaXQgZmV0Y2hDb250YWN0TWV0YWRhdGEoc29ja2V0LCBqaWQpO1xuICAgICAgXG4gICAgICAvLyA9PT09PSB2NC41LjA6IERldGVjdGFyIG3DrWRpYSBpbmNsdWluZG8gc3RpY2tlciA9PT09PVxuICAgICAgbGV0IG1lZGlhVXJsID0gbnVsbDtcbiAgICAgIGxldCBtZWRpYVR5cGUgPSBudWxsO1xuICAgICAgY29uc3QgbXNnQ29udGVudCA9IG1zZy5tZXNzYWdlO1xuICAgICAgXG4gICAgICBpZiAobXNnQ29udGVudCkge1xuICAgICAgICBpZiAobXNnQ29udGVudC5pbWFnZU1lc3NhZ2UpIG1lZGlhVHlwZSA9ICdpbWFnZSc7XG4gICAgICAgIGVsc2UgaWYgKG1zZ0NvbnRlbnQudmlkZW9NZXNzYWdlKSBtZWRpYVR5cGUgPSAndmlkZW8nO1xuICAgICAgICBlbHNlIGlmIChtc2dDb250ZW50LmF1ZGlvTWVzc2FnZSkge1xuICAgICAgICAgIG1lZGlhVHlwZSA9IG1zZ0NvbnRlbnQuYXVkaW9NZXNzYWdlLnB0dCA/ICdwdHQnIDogJ2F1ZGlvJztcbiAgICAgICAgfVxuICAgICAgICBlbHNlIGlmIChtc2dDb250ZW50LmRvY3VtZW50TWVzc2FnZSkgbWVkaWFUeXBlID0gJ2RvY3VtZW50JztcbiAgICAgICAgZWxzZSBpZiAobXNnQ29udGVudC5zdGlja2VyTWVzc2FnZSkgbWVkaWFUeXBlID0gJ3N0aWNrZXInO1xuICAgICAgfVxuXG4gICAgICAvLyA9PT09PSB2NC41LjA6IERvd25sb2FkIGRlIFRPREFTIGFzIG3DrWRpYXMgaW5jbHVpbmRvIHN0aWNrZXJzID09PT09XG4gICAgICBpZiAobWVkaWFUeXBlICYmIFNVUEFCQVNFX1VSTCAmJiBTVVBBQkFTRV9TRVJWSUNFX1JPTEVfS0VZKSB7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgYXdhaXQgYWNxdWlyZURvd25sb2FkKCk7XG4gICAgICAgICAgY29uc3QgYnVmZmVyID0gYXdhaXQgZG93bmxvYWRNZWRpYU1lc3NhZ2UobXNnLCAnYnVmZmVyJywge30pO1xuICAgICAgICAgIFxuICAgICAgICAgIGlmIChidWZmZXIpIHtcbiAgICAgICAgICAgIG1lZGlhVXJsID0gYXdhaXQgdXBsb2FkTWVkaWFUb1N0b3JhZ2UoYnVmZmVyLCBzZXNzaW9uSWQsIG1zZy5rZXkuaWQsIG1lZGlhVHlwZSk7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhg8J+TjiBNw61kaWEgJHttZWRpYVR5cGV9IHNhbHZhOiAke21lZGlhVXJsID8gJ09LJyA6ICdGQUxIT1UnfWApO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm8gZG93bmxvYWQgbcOtZGlhOicsIGUubWVzc2FnZSk7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgcmVsZWFzZURvd25sb2FkKCk7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gRGFkb3MgZGUgZ3J1cG9cbiAgICAgIGNvbnN0IGlzR3JvdXAgPSBqaWQuZW5kc1dpdGgoJ0BnLnVzJyk7XG4gICAgICBjb25zdCBwYXJ0aWNpcGFudCA9IG1zZy5rZXk/LnBhcnRpY2lwYW50O1xuICAgICAgXG4gICAgICBsZXQgc2VuZGVyUGhvbmUgPSBudWxsO1xuICAgICAgbGV0IHNlbmRlck5hbWUgPSBudWxsO1xuICAgICAgXG4gICAgICBpZiAoaXNHcm91cCAmJiBwYXJ0aWNpcGFudCkge1xuICAgICAgICBzZW5kZXJQaG9uZSA9IHBhcnRpY2lwYW50LnNwbGl0KCdAJylbMF0ucmVwbGFjZSgvXFxEL2csICcnKTtcbiAgICAgICAgc2VuZGVyTmFtZSA9IGNvbnRhY3ROYW1lc0NhY2hlLmdldChwYXJ0aWNpcGFudCkgfHwgbXNnLnB1c2hOYW1lIHx8IG51bGw7XG4gICAgICB9XG4gICAgICBcbiAgICAgIGlmICghaXNHcm91cCAmJiAhbXNnLmtleS5mcm9tTWUpIHtcbiAgICAgICAgc2VuZGVyTmFtZSA9IGNvbnRhY3ROYW1lc0NhY2hlLmdldChqaWQpIHx8IG1zZy5wdXNoTmFtZSB8fCBudWxsO1xuICAgICAgfVxuXG4gICAgICAvLyBOb21lIGRvIGdydXBvXG4gICAgICBjb25zdCBncm91cE5hbWUgPSBpc0dyb3VwID8gKG1ldGFkYXRhLmdyb3VwU3ViamVjdCB8fCBudWxsKSA6IG51bGw7XG5cbiAgICAgIC8vIEVudmlhciB3ZWJob29rXG4gICAgICBhd2FpdCBzZW5kV2ViaG9vayh7XG4gICAgICAgIGV2ZW50OiAnbWVzc2FnZXMudXBzZXJ0JyxcbiAgICAgICAgc2Vzc2lvbklkLFxuICAgICAgICBpbnN0YW5jZU5hbWUsXG4gICAgICAgIGRhdGE6IHtcbiAgICAgICAgICBtZXNzYWdlczogW3tcbiAgICAgICAgICAgIGtleTogbXNnLmtleSxcbiAgICAgICAgICAgIG1lc3NhZ2U6IG1zZy5tZXNzYWdlLFxuICAgICAgICAgICAgbWVzc2FnZVRpbWVzdGFtcDogbXNnLm1lc3NhZ2VUaW1lc3RhbXAsXG4gICAgICAgICAgICBwdXNoTmFtZTogbXNnLnB1c2hOYW1lLFxuICAgICAgICAgICAgbWVkaWFVcmwsXG4gICAgICAgICAgICBtZWRpYVR5cGUsXG4gICAgICAgICAgICBzZW5kZXJQaG9uZSxcbiAgICAgICAgICAgIHNlbmRlck5hbWUsXG4gICAgICAgICAgICBncm91cE5hbWUsXG4gICAgICAgICAgICBjb250YWN0TWV0YWRhdGE6IG1ldGFkYXRhXG4gICAgICAgICAgfV1cbiAgICAgICAgfVxuICAgICAgfSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCk7XG4gICAgfVxuICB9KTtcblxuICAvLyA9PT09PSBBVFVBTElaQcOHw4NPIERFIFNUQVRVUyAoTElEQVMpID09PT09XG4gIHNvY2tldC5ldi5vbignbWVzc2FnZXMudXBkYXRlJywgYXN5bmMgKHVwZGF0ZXMpID0+IHtcbiAgICBjb25zb2xlLmxvZyhg8J+TiyBtZXNzYWdlcy51cGRhdGU6ICR7dXBkYXRlcy5sZW5ndGh9IGF0dWFsaXphw6fDtWVzYCk7XG4gICAgXG4gICAgYXdhaXQgc2VuZFdlYmhvb2soe1xuICAgICAgZXZlbnQ6ICdtZXNzYWdlcy51cGRhdGUnLFxuICAgICAgc2Vzc2lvbklkLFxuICAgICAgaW5zdGFuY2VOYW1lLFxuICAgICAgZGF0YTogeyB1cGRhdGVzIH1cbiAgICB9LCB3ZWJob29rVXJsLCB3ZWJob29rU2VjcmV0KTtcbiAgfSk7XG5cbiAgLy8gUmVjaWJvcyBkZSBsZWl0dXJhXG4gIHNvY2tldC5ldi5vbignbWVzc2FnZS1yZWNlaXB0LnVwZGF0ZScsIGFzeW5jICh1cGRhdGVzKSA9PiB7XG4gICAgY29uc29sZS5sb2coYOKchSBtZXNzYWdlLXJlY2VpcHQudXBkYXRlOiAke3VwZGF0ZXMubGVuZ3RofSByZWNpYm9zYCk7XG4gICAgXG4gICAgYXdhaXQgc2VuZFdlYmhvb2soe1xuICAgICAgZXZlbnQ6ICdtZXNzYWdlLXJlY2VpcHQudXBkYXRlJyxcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGluc3RhbmNlTmFtZSxcbiAgICAgIGRhdGE6IHsgdXBkYXRlcyB9XG4gICAgfSwgd2ViaG9va1VybCwgd2ViaG9va1NlY3JldCk7XG4gIH0pO1xuXG4gIHJldHVybiBzZXNzaW9uO1xufVxuXG4vLyA9PT09PT09PT09PT0gUk9UQVMgPT09PT09PT09PT09XG5cbi8vIEhlYWx0aCBjaGVja1xuYXBwLmdldCgnL2FwaS9oZWFsdGgnLCAocmVxLCByZXMpID0+IHtcbiAgcmVzLmpzb24oeyBcbiAgICBzdGF0dXM6ICdvaycsIFxuICAgIHZlcnNpb246ICc0LjYuMCcsXG4gICAgc2Vzc2lvbnM6IHNlc3Npb25zLnNpemUsXG4gICAgdGltZXN0YW1wOiBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCksXG4gICAgaGlzdG9yeUhvdXJzOiA2LFxuICAgIGZlYXR1cmVzOiBbJ3Byb2FjdGl2ZS1tZXRhZGF0YS1zeW5jJywgJ3N0aWNrZXItZG93bmxvYWQnLCAnY29udGFjdC1uYW1lLWNhY2hlJywgJ2dyb3VwLXNlbmRlci1uYW1lcyddXG4gIH0pO1xufSk7XG5cbi8vIENyaWFyIGluc3TDom5jaWFcbmFwcC5wb3N0KCcvYXBpL2luc3RhbmNlL2NyZWF0ZScsIGFzeW5jIChyZXEsIHJlcykgPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgc2Vzc2lvbklkLCBpbnN0YW5jZU5hbWUsIHdlYmhvb2tVcmwsIHdlYmhvb2tTZWNyZXQgfSA9IHJlcS5ib2R5O1xuICAgIFxuICAgIGlmICghc2Vzc2lvbklkIHx8ICFpbnN0YW5jZU5hbWUpIHtcbiAgICAgIHJldHVybiByZXMuc3RhdHVzKDQwMCkuanNvbih7IGVycm9yOiAnc2Vzc2lvbklkIGUgaW5zdGFuY2VOYW1lIHPDo28gb2JyaWdhdMOzcmlvcycgfSk7XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IHNlc3Npb24gPSBhd2FpdCBjcmVhdGVTZXNzaW9uKHtcbiAgICAgIHNlc3Npb25JZCxcbiAgICAgIGluc3RhbmNlTmFtZSxcbiAgICAgIHdlYmhvb2tVcmw6IHdlYmhvb2tVcmwgfHwgU1VQQUJBU0VfV0VCSE9PS19VUkwsXG4gICAgICB3ZWJob29rU2VjcmV0OiB3ZWJob29rU2VjcmV0IHx8ICcnXG4gICAgfSk7XG4gICAgXG4gICAgcmVzLmpzb24oe1xuICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgIHNlc3Npb25JZDogc2Vzc2lvbj8uc2Vzc2lvbklkLFxuICAgICAgaW5zdGFuY2VOYW1lOiBzZXNzaW9uPy5pbnN0YW5jZU5hbWUsXG4gICAgICBxckNvZGU6IHNlc3Npb24/LnFyQ29kZVxuICAgIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm8gY3JpYXIgaW5zdMOibmNpYTonLCBlcnJvcik7XG4gICAgcmVzLnN0YXR1cyg1MDApLmpzb24oeyBlcnJvcjogJ0ZhbGhhIGFvIGNyaWFyIGluc3TDom5jaWEnIH0pO1xuICB9XG59KTtcblxuLy8gT2J0ZXIgUVIgQ29kZVxuYXBwLmdldCgnL2FwaS9pbnN0YW5jZS86aW5zdGFuY2VOYW1lL3FyJywgKHJlcSwgcmVzKSA9PiB7XG4gIGNvbnN0IHNlc3Npb24gPSBBcnJheS5mcm9tKHNlc3Npb25zLnZhbHVlcygpKS5maW5kKHMgPT4gcy5pbnN0YW5jZU5hbWUgPT09IHJlcS5wYXJhbXMuaW5zdGFuY2VOYW1lKTtcbiAgXG4gIGlmICghc2Vzc2lvbikge1xuICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuanNvbih7IGVycm9yOiAnU2Vzc8OjbyBuw6NvIGVuY29udHJhZGEnIH0pO1xuICB9XG4gIFxuICByZXMuanNvbih7XG4gICAgcXJDb2RlOiBzZXNzaW9uLnFyQ29kZSxcbiAgICBpc0Nvbm5lY3RlZDogc2Vzc2lvbi5pc0Nvbm5lY3RlZFxuICB9KTtcbn0pO1xuXG4vLyBTdGF0dXMgZGEgaW5zdMOibmNpYVxuYXBwLmdldCgnL2FwaS9pbnN0YW5jZS86aW5zdGFuY2VOYW1lL3N0YXR1cycsIChyZXEsIHJlcykgPT4ge1xuICBjb25zdCBzZXNzaW9uID0gQXJyYXkuZnJvbShzZXNzaW9ucy52YWx1ZXMoKSkuZmluZChzID0+IHMuaW5zdGFuY2VOYW1lID09PSByZXEucGFyYW1zLmluc3RhbmNlTmFtZSk7XG4gIFxuICBpZiAoIXNlc3Npb24pIHtcbiAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDQpLmpzb24oeyBlcnJvcjogJ1Nlc3PDo28gbsOjbyBlbmNvbnRyYWRhJyB9KTtcbiAgfVxuICBcbiAgcmVzLmpzb24oe1xuICAgIHN0YXR1czogc2Vzc2lvbi5pc0Nvbm5lY3RlZCA/ICdjb25uZWN0ZWQnIDogJ2Rpc2Nvbm5lY3RlZCcsXG4gICAgaXNDb25uZWN0ZWQ6IHNlc3Npb24uaXNDb25uZWN0ZWQsXG4gICAgcGhvbmVOdW1iZXI6IHNlc3Npb24ucGhvbmVOdW1iZXIsXG4gICAgcHVzaE5hbWU6IHNlc3Npb24ucHVzaE5hbWUsXG4gICAgcHJvZmlsZVBpY3R1cmU6IHNlc3Npb24ucHJvZmlsZVBpY3R1cmUsXG4gICAgY29udGFjdHNDb3VudDogc2Vzc2lvbi5hbGxDb250YWN0cz8uc2l6ZSB8fCAwLFxuICAgIGNoYXRzQ291bnQ6IHNlc3Npb24uYWxsQ2hhdHM/LnNpemUgfHwgMFxuICB9KTtcbn0pO1xuXG4vLyBMb2dvdXRcbmFwcC5wb3N0KCcvYXBpL2luc3RhbmNlLzppbnN0YW5jZU5hbWUvbG9nb3V0JywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gIGNvbnN0IHNlc3Npb24gPSBBcnJheS5mcm9tKHNlc3Npb25zLnZhbHVlcygpKS5maW5kKHMgPT4gcy5pbnN0YW5jZU5hbWUgPT09IHJlcS5wYXJhbXMuaW5zdGFuY2VOYW1lKTtcbiAgXG4gIGlmICghc2Vzc2lvbikge1xuICAgIHJldHVybiByZXMuc3RhdHVzKDQwNCkuanNvbih7IGVycm9yOiAnU2Vzc8OjbyBuw6NvIGVuY29udHJhZGEnIH0pO1xuICB9XG4gIFxuICB0cnkge1xuICAgIGlmIChzZXNzaW9uLnNvY2tldCkge1xuICAgICAgYXdhaXQgc2Vzc2lvbi5zb2NrZXQubG9nb3V0KCk7XG4gICAgfVxuICAgIHNlc3Npb25zLmRlbGV0ZShzZXNzaW9uLnNlc3Npb25JZCk7XG4gICAgcmVzLmpzb24oeyBzdWNjZXNzOiB0cnVlIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJlcy5zdGF0dXMoNTAwKS5qc29uKHsgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfSk7XG4gIH1cbn0pO1xuXG4vLyBEZWxldGFyIGluc3TDom5jaWFcbmFwcC5kZWxldGUoJy9hcGkvaW5zdGFuY2UvOmluc3RhbmNlTmFtZS9kZWxldGUnLCBhc3luYyAocmVxLCByZXMpID0+IHtcbiAgY29uc3Qgc2Vzc2lvbiA9IEFycmF5LmZyb20oc2Vzc2lvbnMudmFsdWVzKCkpLmZpbmQocyA9PiBzLmluc3RhbmNlTmFtZSA9PT0gcmVxLnBhcmFtcy5pbnN0YW5jZU5hbWUpO1xuICBcbiAgaWYgKCFzZXNzaW9uKSB7XG4gICAgcmV0dXJuIHJlcy5zdGF0dXMoNDA0KS5qc29uKHsgZXJyb3I6ICdTZXNzw6NvIG7Do28gZW5jb250cmFkYScgfSk7XG4gIH1cbiAgXG4gIHRyeSB7XG4gICAgaWYgKHNlc3Npb24uc29ja2V0KSB7XG4gICAgICBhd2FpdCBzZXNzaW9uLnNvY2tldC5sb2dvdXQoKTtcbiAgICB9XG4gICAgXG4gICAgY29uc3Qgc2Vzc2lvblBhdGggPSBwYXRoLmpvaW4oX19kaXJuYW1lLCAnc2Vzc2lvbnMnLCBzZXNzaW9uLmluc3RhbmNlTmFtZSk7XG4gICAgaWYgKGZzLmV4aXN0c1N5bmMoc2Vzc2lvblBhdGgpKSB7XG4gICAgICBmcy5ybVN5bmMoc2Vzc2lvblBhdGgsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH1cbiAgICBcbiAgICBzZXNzaW9ucy5kZWxldGUoc2Vzc2lvbi5zZXNzaW9uSWQpO1xuICAgIHJlcy5qc29uKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICByZXMuc3RhdHVzKDUwMCkuanNvbih7IGVycm9yOiBlcnJvci5tZXNzYWdlIH0pO1xuICB9XG59KTtcblxuLy8gTGlzdGFyIGluc3TDom5jaWFzXG5hcHAuZ2V0KCcvYXBpL2luc3RhbmNlL2xpc3QnLCAocmVxLCByZXMpID0+IHtcbiAgY29uc3Qgc2Vzc2lvbkxpc3QgPSBBcnJheS5mcm9tKHNlc3Npb25zLnZhbHVlcygpKS5tYXAocyA9PiAoe1xuICAgIHNlc3Npb25JZDogcy5zZXNzaW9uSWQsXG4gICAgaW5zdGFuY2VOYW1lOiBzLmluc3RhbmNlTmFtZSxcbiAgICBpc0Nvbm5lY3RlZDogcy5pc0Nvbm5lY3RlZCxcbiAgICBwaG9uZU51bWJlcjogcy5waG9uZU51bWJlcixcbiAgICBwdXNoTmFtZTogcy5wdXNoTmFtZSxcbiAgICBjb250YWN0c0NvdW50OiBzLmFsbENvbnRhY3RzPy5zaXplIHx8IDAsXG4gICAgY2hhdHNDb3VudDogcy5hbGxDaGF0cz8uc2l6ZSB8fCAwXG4gIH0pKTtcbiAgXG4gIHJlcy5qc29uKHsgc2Vzc2lvbnM6IHNlc3Npb25MaXN0IH0pO1xufSk7XG5cbi8vID09PT09IEVORFBPSU5UIFBBUkEgU1lOQyBDT01QTEVUTyBERSBDT05UQVRPUyA9PT09PVxuYXBwLnBvc3QoJy9hcGkvc3luYy9jb250YWN0cycsIGFzeW5jIChyZXEsIHJlcykgPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgaW5zdGFuY2VOYW1lLCBwYWdlID0gMSwgcGFnZVNpemUgPSA1MCB9ID0gcmVxLmJvZHk7XG4gICAgXG4gICAgY29uc3Qgc2Vzc2lvbiA9IEFycmF5LmZyb20oc2Vzc2lvbnMudmFsdWVzKCkpLmZpbmQocyA9PiBzLmluc3RhbmNlTmFtZSA9PT0gaW5zdGFuY2VOYW1lKTtcbiAgICBpZiAoIXNlc3Npb24gfHwgIXNlc3Npb24uc29ja2V0IHx8ICFzZXNzaW9uLmlzQ29ubmVjdGVkKSB7XG4gICAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDQpLmpzb24oeyBlcnJvcjogJ1Nlc3PDo28gbsOjbyBlbmNvbnRyYWRhIG91IGRlc2NvbmVjdGFkYScgfSk7XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IGFsbENvbnRhY3RzID0gQXJyYXkuZnJvbShzZXNzaW9uLmFsbENvbnRhY3RzLnZhbHVlcygpKTtcbiAgICBjb25zdCB0b3RhbENvbnRhY3RzID0gYWxsQ29udGFjdHMubGVuZ3RoO1xuICAgIGNvbnN0IHRvdGFsUGFnZXMgPSBNYXRoLmNlaWwodG90YWxDb250YWN0cyAvIHBhZ2VTaXplKTtcbiAgICBjb25zdCBzdGFydEluZGV4ID0gKHBhZ2UgLSAxKSAqIHBhZ2VTaXplO1xuICAgIGNvbnN0IGVuZEluZGV4ID0gc3RhcnRJbmRleCArIHBhZ2VTaXplO1xuICAgIFxuICAgIGNvbnN0IGNvbnRhY3RzID0gYWxsQ29udGFjdHMuc2xpY2Uoc3RhcnRJbmRleCwgZW5kSW5kZXgpO1xuICAgIFxuICAgIC8vIEVucmlxdWVjZSBjb20gbWV0YWRhZG9zXG4gICAgY29uc3QgZW5yaWNoZWRDb250YWN0cyA9IFtdO1xuICAgIGZvciAoY29uc3QgY29udGFjdCBvZiBjb250YWN0cykge1xuICAgICAgY29uc3QgamlkID0gY29udGFjdC5pZCB8fCBjb250YWN0LmppZDtcbiAgICAgIGlmICghamlkIHx8IGppZCA9PT0gJ3N0YXR1c0Bicm9hZGNhc3QnKSBjb250aW51ZTtcbiAgICAgIFxuICAgICAgdHJ5IHtcbiAgICAgICAgY29uc3QgbWV0YSA9IGF3YWl0IGZldGNoQ29udGFjdE1ldGFkYXRhKHNlc3Npb24uc29ja2V0LCBqaWQpO1xuICAgICAgICBlbnJpY2hlZENvbnRhY3RzLnB1c2goe1xuICAgICAgICAgIC4uLmNvbnRhY3QsXG4gICAgICAgICAgamlkLFxuICAgICAgICAgIHByb2ZpbGVQaWN0dXJlOiBtZXRhLnByb2ZpbGVQaWN0dXJlLFxuICAgICAgICAgIHN0YXR1czogbWV0YS5zdGF0dXMsXG4gICAgICAgICAgZ3JvdXBTdWJqZWN0OiBtZXRhLmdyb3VwU3ViamVjdCxcbiAgICAgICAgICBncm91cERlc2NyaXB0aW9uOiBtZXRhLmdyb3VwRGVzY3JpcHRpb25cbiAgICAgICAgfSk7XG4gICAgICAgIGF3YWl0IGRlbGF5KDUwKTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgZW5yaWNoZWRDb250YWN0cy5wdXNoKHsgLi4uY29udGFjdCwgamlkIH0pO1xuICAgICAgfVxuICAgIH1cbiAgICBcbiAgICByZXMuanNvbih7XG4gICAgICBzdWNjZXNzOiB0cnVlLFxuICAgICAgcGFnZSxcbiAgICAgIHBhZ2VTaXplLFxuICAgICAgdG90YWxQYWdlcyxcbiAgICAgIHRvdGFsQ29udGFjdHMsXG4gICAgICBjb250YWN0czogZW5yaWNoZWRDb250YWN0cyxcbiAgICAgIGhhc01vcmU6IHBhZ2UgPCB0b3RhbFBhZ2VzXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJybyBzeW5jIGNvbnRhdG9zOicsIGVycm9yKTtcbiAgICByZXMuc3RhdHVzKDUwMCkuanNvbih7IGVycm9yOiAnRmFsaGEgbm8gc3luYyBkZSBjb250YXRvcycgfSk7XG4gIH1cbn0pO1xuXG4vLyA9PT09PSBFTkRQT0lOVCBQQVJBIFNZTkMgQ09NUExFVE8gREUgQ0hBVFMgPT09PT1cbmFwcC5wb3N0KCcvYXBpL3N5bmMvY2hhdHMnLCBhc3luYyAocmVxLCByZXMpID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGluc3RhbmNlTmFtZSwgcGFnZSA9IDEsIHBhZ2VTaXplID0gMzAgfSA9IHJlcS5ib2R5O1xuICAgIFxuICAgIGNvbnN0IHNlc3Npb24gPSBBcnJheS5mcm9tKHNlc3Npb25zLnZhbHVlcygpKS5maW5kKHMgPT4gcy5pbnN0YW5jZU5hbWUgPT09IGluc3RhbmNlTmFtZSk7XG4gICAgaWYgKCFzZXNzaW9uIHx8ICFzZXNzaW9uLnNvY2tldCB8fCAhc2Vzc2lvbi5pc0Nvbm5lY3RlZCkge1xuICAgICAgcmV0dXJuIHJlcy5zdGF0dXMoNDA0KS5qc29uKHsgZXJyb3I6ICdTZXNzw6NvIG7Do28gZW5jb250cmFkYSBvdSBkZXNjb25lY3RhZGEnIH0pO1xuICAgIH1cbiAgICBcbiAgICBjb25zdCBhbGxDaGF0cyA9IEFycmF5LmZyb20oc2Vzc2lvbi5hbGxDaGF0cy52YWx1ZXMoKSk7XG4gICAgY29uc3QgdG90YWxDaGF0cyA9IGFsbENoYXRzLmxlbmd0aDtcbiAgICBjb25zdCB0b3RhbFBhZ2VzID0gTWF0aC5jZWlsKHRvdGFsQ2hhdHMgLyBwYWdlU2l6ZSk7XG4gICAgY29uc3Qgc3RhcnRJbmRleCA9IChwYWdlIC0gMSkgKiBwYWdlU2l6ZTtcbiAgICBjb25zdCBlbmRJbmRleCA9IHN0YXJ0SW5kZXggKyBwYWdlU2l6ZTtcbiAgICBcbiAgICBjb25zdCBjaGF0cyA9IGFsbENoYXRzLnNsaWNlKHN0YXJ0SW5kZXgsIGVuZEluZGV4KTtcbiAgICBcbiAgICAvLyBFbnJpcXVlY2UgY29tIG1ldGFkYWRvc1xuICAgIGNvbnN0IGVucmljaGVkQ2hhdHMgPSBbXTtcbiAgICBmb3IgKGNvbnN0IGNoYXQgb2YgY2hhdHMpIHtcbiAgICAgIGNvbnN0IGppZCA9IGNoYXQuaWQgfHwgY2hhdC5qaWQ7XG4gICAgICBpZiAoIWppZCB8fCBqaWQgPT09ICdzdGF0dXNAYnJvYWRjYXN0JykgY29udGludWU7XG4gICAgICBcbiAgICAgIHRyeSB7XG4gICAgICAgIGNvbnN0IG1ldGEgPSBhd2FpdCBmZXRjaENvbnRhY3RNZXRhZGF0YShzZXNzaW9uLnNvY2tldCwgamlkKTtcbiAgICAgICAgY29uc3QgaXNHcm91cCA9IGppZC5lbmRzV2l0aCgnQGcudXMnKTtcbiAgICAgICAgXG4gICAgICAgIGNvbnN0IGVucmljaGVkID0ge1xuICAgICAgICAgIC4uLmNoYXQsXG4gICAgICAgICAgamlkLFxuICAgICAgICAgIHByb2ZpbGVQaWN0dXJlOiBtZXRhLnByb2ZpbGVQaWN0dXJlXG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICBpZiAoaXNHcm91cCkge1xuICAgICAgICAgIGVucmljaGVkLmdyb3VwU3ViamVjdCA9IG1ldGEuZ3JvdXBTdWJqZWN0IHx8IGNoYXQubmFtZTtcbiAgICAgICAgICBlbnJpY2hlZC5ncm91cERlc2NyaXB0aW9uID0gbWV0YS5ncm91cERlc2NyaXB0aW9uO1xuICAgICAgICAgIGVucmljaGVkLmdyb3VwUGFydGljaXBhbnRzID0gbWV0YS5ncm91cFBhcnRpY2lwYW50cztcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgZW5yaWNoZWRDaGF0cy5wdXNoKGVucmljaGVkKTtcbiAgICAgICAgYXdhaXQgZGVsYXkoNTApO1xuICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICBlbnJpY2hlZENoYXRzLnB1c2goeyAuLi5jaGF0LCBqaWQgfSk7XG4gICAgICB9XG4gICAgfVxuICAgIFxuICAgIHJlcy5qc29uKHtcbiAgICAgIHN1Y2Nlc3M6IHRydWUsXG4gICAgICBwYWdlLFxuICAgICAgcGFnZVNpemUsXG4gICAgICB0b3RhbFBhZ2VzLFxuICAgICAgdG90YWxDaGF0cyxcbiAgICAgIGNoYXRzOiBlbnJpY2hlZENoYXRzLFxuICAgICAgaGFzTW9yZTogcGFnZSA8IHRvdGFsUGFnZXNcbiAgICB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvIHN5bmMgY2hhdHM6JywgZXJyb3IpO1xuICAgIHJlcy5zdGF0dXMoNTAwKS5qc29uKHsgZXJyb3I6ICdGYWxoYSBubyBzeW5jIGRlIGNoYXRzJyB9KTtcbiAgfVxufSk7XG5cbi8vIEVudmlhciBtZW5zYWdlbVxuYXBwLnBvc3QoJy9hcGkvbWVzc2FnZS9zZW5kJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBpbnN0YW5jZU5hbWUsIGppZCwgbWVzc2FnZSB9ID0gcmVxLmJvZHk7XG4gICAgXG4gICAgY29uc3Qgc2Vzc2lvbiA9IEFycmF5LmZyb20oc2Vzc2lvbnMudmFsdWVzKCkpLmZpbmQocyA9PiBzLmluc3RhbmNlTmFtZSA9PT0gaW5zdGFuY2VOYW1lKTtcbiAgICBpZiAoIXNlc3Npb24gfHwgIXNlc3Npb24uc29ja2V0IHx8ICFzZXNzaW9uLmlzQ29ubmVjdGVkKSB7XG4gICAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDQpLmpzb24oeyBlcnJvcjogJ1Nlc3PDo28gbsOjbyBlbmNvbnRyYWRhIG91IGRlc2NvbmVjdGFkYScgfSk7XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlc3Npb24uc29ja2V0LnNlbmRNZXNzYWdlKGppZCwgbWVzc2FnZSk7XG4gICAgXG4gICAgcmVzLmpzb24oe1xuICAgICAgc3VjY2VzczogdHJ1ZSxcbiAgICAgIG1lc3NhZ2VJZDogcmVzdWx0LmtleS5pZCxcbiAgICAgIGtleTogcmVzdWx0LmtleVxuICAgIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGNvbnNvbGUuZXJyb3IoJ0Vycm8gZW52aWFyOicsIGVycm9yKTtcbiAgICByZXMuc3RhdHVzKDUwMCkuanNvbih7IGVycm9yOiAnRmFsaGEgYW8gZW52aWFyJyB9KTtcbiAgfVxufSk7XG5cbi8vIEVudmlhciBtw61kaWFcbmFwcC5wb3N0KCcvYXBpL21lc3NhZ2Uvc2VuZC1tZWRpYScsIGFzeW5jIChyZXEsIHJlcykgPT4ge1xuICB0cnkge1xuICAgIGNvbnN0IHsgaW5zdGFuY2VOYW1lLCBqaWQsIG1lZGlhVXJsLCBtZWRpYVR5cGUsIGNhcHRpb24gfSA9IHJlcS5ib2R5O1xuICAgIFxuICAgIGNvbnN0IHNlc3Npb24gPSBBcnJheS5mcm9tKHNlc3Npb25zLnZhbHVlcygpKS5maW5kKHMgPT4gcy5pbnN0YW5jZU5hbWUgPT09IGluc3RhbmNlTmFtZSk7XG4gICAgaWYgKCFzZXNzaW9uIHx8ICFzZXNzaW9uLnNvY2tldCB8fCAhc2Vzc2lvbi5pc0Nvbm5lY3RlZCkge1xuICAgICAgcmV0dXJuIHJlcy5zdGF0dXMoNDA0KS5qc29uKHsgZXJyb3I6ICdTZXNzw6NvIG7Do28gZW5jb250cmFkYScgfSk7XG4gICAgfVxuICAgIFxuICAgIGxldCBtZXNzYWdlQ29udGVudDtcbiAgICBzd2l0Y2ggKG1lZGlhVHlwZSkge1xuICAgICAgY2FzZSAnaW1hZ2UnOlxuICAgICAgICBtZXNzYWdlQ29udGVudCA9IHsgaW1hZ2U6IHsgdXJsOiBtZWRpYVVybCB9LCBjYXB0aW9uIH07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAndmlkZW8nOlxuICAgICAgICBtZXNzYWdlQ29udGVudCA9IHsgdmlkZW86IHsgdXJsOiBtZWRpYVVybCB9LCBjYXB0aW9uIH07XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAnYXVkaW8nOlxuICAgICAgICBtZXNzYWdlQ29udGVudCA9IHsgYXVkaW86IHsgdXJsOiBtZWRpYVVybCB9LCBtaW1ldHlwZTogJ2F1ZGlvL21wNCcsIHB0dDogZmFsc2UgfTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdkb2N1bWVudCc6XG4gICAgICAgIG1lc3NhZ2VDb250ZW50ID0geyBkb2N1bWVudDogeyB1cmw6IG1lZGlhVXJsIH0sIGZpbGVOYW1lOiBjYXB0aW9uIHx8ICdkb2N1bWVudCcgfTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBkZWZhdWx0OlxuICAgICAgICBtZXNzYWdlQ29udGVudCA9IHsgaW1hZ2U6IHsgdXJsOiBtZWRpYVVybCB9LCBjYXB0aW9uIH07XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlc3Npb24uc29ja2V0LnNlbmRNZXNzYWdlKGppZCwgbWVzc2FnZUNvbnRlbnQpO1xuICAgIHJlcy5qc29uKHsgc3VjY2VzczogdHJ1ZSwgbWVzc2FnZUlkOiByZXN1bHQua2V5LmlkLCBrZXk6IHJlc3VsdC5rZXkgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgcmVzLnN0YXR1cyg1MDApLmpzb24oeyBlcnJvcjogJ0ZhbGhhIGFvIGVudmlhciBtw61kaWEnIH0pO1xuICB9XG59KTtcblxuLy8gRW52aWFyIHZveiAoUFRUKVxuYXBwLnBvc3QoJy9hcGkvbWVzc2FnZS9zZW5kLXZvaWNlJywgYXN5bmMgKHJlcSwgcmVzKSA9PiB7XG4gIHRyeSB7XG4gICAgY29uc3QgeyBpbnN0YW5jZU5hbWUsIGppZCwgYXVkaW9VcmwgfSA9IHJlcS5ib2R5O1xuICAgIFxuICAgIGNvbnN0IHNlc3Npb24gPSBBcnJheS5mcm9tKHNlc3Npb25zLnZhbHVlcygpKS5maW5kKHMgPT4gcy5pbnN0YW5jZU5hbWUgPT09IGluc3RhbmNlTmFtZSk7XG4gICAgaWYgKCFzZXNzaW9uIHx8ICFzZXNzaW9uLnNvY2tldCB8fCAhc2Vzc2lvbi5pc0Nvbm5lY3RlZCkge1xuICAgICAgcmV0dXJuIHJlcy5zdGF0dXMoNDA0KS5qc29uKHsgZXJyb3I6ICdTZXNzw6NvIG7Do28gZW5jb250cmFkYScgfSk7XG4gICAgfVxuICAgIFxuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHNlc3Npb24uc29ja2V0LnNlbmRNZXNzYWdlKGppZCwge1xuICAgICAgYXVkaW86IHsgdXJsOiBhdWRpb1VybCB9LFxuICAgICAgbWltZXR5cGU6ICdhdWRpby9vZ2c7IGNvZGVjcz1vcHVzJyxcbiAgICAgIHB0dDogdHJ1ZVxuICAgIH0pO1xuICAgIFxuICAgIHJlcy5qc29uKHsgc3VjY2VzczogdHJ1ZSwgbWVzc2FnZUlkOiByZXN1bHQua2V5LmlkLCBrZXk6IHJlc3VsdC5rZXkgfSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY29uc29sZS5lcnJvcignRXJybyBlbnZpYXIgdm96OicsIGVycm9yKTtcbiAgICByZXMuc3RhdHVzKDUwMCkuanNvbih7IGVycm9yOiAnRmFsaGEgYW8gZW52aWFyIHZveicgfSk7XG4gIH1cbn0pO1xuXG4vLyBNYXJjYXIgY29tbyBsaWRvXG5hcHAucG9zdCgnL2FwaS9tZXNzYWdlL3JlYWQnLCBhc3luYyAocmVxLCByZXMpID0+IHtcbiAgdHJ5IHtcbiAgICBjb25zdCB7IGluc3RhbmNlTmFtZSwga2V5cyB9ID0gcmVxLmJvZHk7XG4gICAgXG4gICAgY29uc3Qgc2Vzc2lvbiA9IEFycmF5LmZyb20oc2Vzc2lvbnMudmFsdWVzKCkpLmZpbmQocyA9PiBzLmluc3RhbmNlTmFtZSA9PT0gaW5zdGFuY2VOYW1lKTtcbiAgICBpZiAoIXNlc3Npb24gfHwgIXNlc3Npb24uc29ja2V0IHx8ICFzZXNzaW9uLmlzQ29ubmVjdGVkKSB7XG4gICAgICByZXR1cm4gcmVzLnN0YXR1cyg0MDQpLmpzb24oeyBlcnJvcjogJ1Nlc3PDo28gbsOjbyBlbmNvbnRyYWRhJyB9KTtcbiAgICB9XG4gICAgXG4gICAgYXdhaXQgc2Vzc2lvbi5zb2NrZXQucmVhZE1lc3NhZ2VzKGtleXMpO1xuICAgIHJlcy5qc29uKHsgc3VjY2VzczogdHJ1ZSB9KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBjb25zb2xlLmVycm9yKCdFcnJvIG1hcmNhciBjb21vIGxpZG86JywgZXJyb3IpO1xuICAgIHJlcy5zdGF0dXMoNTAwKS5qc29uKHsgZXJyb3I6ICdGYWxoYSBhbyBtYXJjYXIgY29tbyBsaWRvJyB9KTtcbiAgfVxufSk7XG5cbi8vIEluaWNpYXIgc2Vydmlkb3JcbnNlcnZlci5saXN0ZW4oUE9SVCwgKCkgPT4ge1xuICBjb25zb2xlLmxvZyhg8J+agCBCYWlsZXlzIFNlcnZlciB2NC42LjAgcm9kYW5kbyBuYSBwb3J0YSAke1BPUlR9YCk7XG4gIGNvbnNvbGUubG9nKGDwn5OhIFdlYmhvb2s6ICR7U1VQQUJBU0VfV0VCSE9PS19VUkwgfHwgJ27Do28gY29uZmlndXJhZG8nfWApO1xuICBjb25zb2xlLmxvZyhg8J+TuCBTeW5jIHByb2F0aXZvIGRlIG1ldGFkYWRvcyBoYWJpbGl0YWRvYCk7XG4gIGNvbnNvbGUubG9nKGDwn5SEIFN5bmMgY29tcGxldG8gZGUgY29udGF0b3MgaGFiaWxpdGFkb2ApO1xuICBjb25zb2xlLmxvZyhg4o+wIEhpc3TDs3JpY28gZGUgbWVuc2FnZW5zOiDDumx0aW1hcyA2IGhvcmFzYCk7XG4gIGNvbnNvbGUubG9nKGDwn46oIFN0aWNrZXJzOiBkb3dubG9hZCBoYWJpbGl0YWRvYCk7XG59KTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsSUFBSTtBQUNsRCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQzVELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxLQUFLO0FBQy9ELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLEtBQUs7QUFDL0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxHQUFHO0FBQzlDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsT0FBTztBQUN0QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENB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Q0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsYUFBYSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzFELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUMxRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLGdCQUFnQixDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsWUFBWSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDO0FBQ3BCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDbkUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUM7QUFDaEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQy9ELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNaLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1gsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzNELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQ25DLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLE1BQU0sQ0FBQztBQUNoRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3ZELENBQUMsQ0FBQyxDQUFDO0FBQ0g7QUFDQSxDQUFDLENBQUMsTUFBTSxDQUFDLFFBQVEsQ0FBQztBQUNsQixDQUFDO0FBQ0Q7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakQsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3RFLEtBQUssQ0FBQyxRQUFRLENBQUMsZUFBZSxDQUFDLE1BQU0sQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUM7QUFDckcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3hELENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1RSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBQ25ELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUNqQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDO0FBQ3hDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUN6RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDYixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxNQUFNLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNuRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2hELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxJQUFJO0FBQzVCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2pDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN4QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNyRixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNsQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ3pGLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNYLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxZQUFZO0FBQ3RELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsUUFBUSxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQ3ZELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDeEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUN4QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3JCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ3BCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLFdBQVcsQ0FBQztBQUNsQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxjQUFjLENBQUM7QUFDeEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7QUFDeEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzNELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxRQUFRLENBQUMsZ0JBQWdCLENBQUM7QUFDNUQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxpQkFBaUI7QUFDN0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDZixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUMxQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDO0FBQ3RCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsV0FBVztBQUN4QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWE7QUFDbkQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ2pGLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNmLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUNyRCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUM7QUFDRDtBQUNBLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsT0FBTztBQUNyQyxLQUFLLENBQUMsUUFBUSxDQUFDLG9CQUFvQixDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDOUUsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMseUJBQXlCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDO0FBQzFFLENBQUMsQ0FBQztBQUNGLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNuQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN4QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDdkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQ3RFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUM7QUFDdkMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUNyRSxD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QUFhLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUM7QUFDeEUsQ0FBQyxDQUFDO0FBQ0YsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDcEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNuQyxDQUFDLENBQUMsQ0FBQztBQUNIO0FBQ0EsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBQ3JFLENBQUMsQ0FBQztBQUNGLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxVQUFVLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDekQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN4RSxDQUFDLENBQUMsQ0FBQztBQUNIO0FBQ0EsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFD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QyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUM7QUFDckQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUNuQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDcEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7QUFDdkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBQ3RDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNSLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMs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QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxXQUFXLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEtBQUs7QUFDdEYsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzlCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN2RixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLGVBQWUsQ0FBQyxNQUFNLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUNuRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUNmLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNqQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDbEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsVUFBVSxDQUFDO0FBQ25FLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLFNBQVMsQ0FBQztBQUN4RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUNuQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7QUFDckIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDZixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDOUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUM7QUFDckIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxlQUFlO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUM7QUFDcEM7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDO0FBQ3hGLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsaUJBQWlCLENBQUMsQ0FBQyxDQUFDO0FBQ3BDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLGlCQUFpQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3BHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2xFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNSLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsTUFBTSxDQUFDLENBQUM7QUFDaEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQztBQUM3RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUNuQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0w7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDeEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDMUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxLQUFLO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7QUFDNUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDOUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsU0FBUztBQUMzQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQztBQUNoRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNuQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUMzQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLE9BQU87QUFDM0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDdEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7QUFDekIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzlCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDbEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQzFCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDaEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDO0FBQ2hFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU07QUFDeEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUNwQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQztBQUM3QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUN6QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDbkUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0w7QUFDQSxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZELENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUM7QUFDbkUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7QUFDNUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDOUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUM7QUFDaEcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDM0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDO0FBQ3hCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUM7QUFDbEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0w7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN2QyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDakUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7QUFDdEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDeEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLE9BQU87QUFDakMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM3QixDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDNUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQztBQUMxQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDekQ7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLG9CQUFvQixDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUM5QztBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdkQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN0QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxLQUFLO0FBQ3ZELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNwRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDO0FBQ2hCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLFdBQVcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxJQUFJO0FBQzFELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDN0gsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxXQUFXLENBQUM7QUFDNUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQyxJQUFJLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDNUYsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNWO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUM7QUFDOUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQy9CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLFdBQVcsQ0FBQztBQUNqQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2hELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDekQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNUO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsVUFBVSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsYUFBYSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsYUFBYSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN2QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUM3QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNwQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUN4QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNO0FBQ3RDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDYixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBQ3hDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNuQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7QUFDaEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0w7QUFDQSxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2pELENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDMUQsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUM7QUFDdEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDeEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUN2QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUM1QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDaEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDO0FBQ25CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBQ2xDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakQsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0STtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSTtBQUNsRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUN6QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQztBQUNoRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7QUFDcEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDbEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFlBQVksQ0FBQztBQUNwRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxpQkFBaUIsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDL0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNiLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNYLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQztBQUM5QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7QUFDL0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUM7QUFDMUQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDbEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDO0FBQ3RCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQztBQUN6QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUN4QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDM0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1A7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDOUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQztBQUMvQztBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM1QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDYixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzlFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQztBQUN2QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNoRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUM7QUFDdEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUNqRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUMvRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNqQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUjtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNyRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLGdCQUFnQixDQUFDLENBQUM7QUFDN0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQztBQUNsQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNUO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDckY7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7QUFDdkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDdEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNqRDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUN4QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQzNEO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNoRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLFdBQVcsQ0FBQztBQUNsRDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdkUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDakMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDaEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNWLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7QUFDdkMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxNQUFNLENBQUMsUUFBUTtBQUM3RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLGlCQUFpQixDQUFDLEdBQUcsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ25GLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNYLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsV0FBVyxDQUFDLFFBQVEsQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFRO0FBQzlELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzVDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsaUJBQWlCLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDM0UsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1g7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUMvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQztBQUM5QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7QUFDdkMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNWLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztBQUMzQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ2xFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQztBQUMvQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUN4RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxlQUFlLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDeEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDdEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1g7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsRixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMseUJBQXlCLENBQUMsQ0FBQyxDQUFDO0FBQ3ZFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ2pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLG9CQUFvQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3pFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLENBQUMsTUFBTSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUM5RixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNmLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQzlFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUN2QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1g7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN2QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUM7QUFDL0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUMsZ0JBQWdCLENBQUM7QUFDakQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUNqQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXLENBQUM7QUFDeEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUNyQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNiLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1Q7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNoQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxXQUFXLENBQUMsQ0FBQztBQUM3QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDO0FBQ3hDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUMzQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMxRixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2pCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsRCxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDO0FBQ2xDO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQ2pDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxHQUFHLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDN0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQztBQUNwQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLFNBQVM7QUFDekIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLG9CQUFvQixDQUFDLE1BQU0sQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQy9ELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ04sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM3RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUM7QUFDMUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQzNCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3pELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsVUFBVSxDQUFDLFlBQVksQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUM5RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsWUFBWSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNwRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLENBQUMsVUFBVSxDQUFDLGVBQWUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUNwRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxjQUFjLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUM7QUFDbEUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxTQUFTLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLHlCQUF5QixDQUFDLENBQUMsQ0FBQztBQUNuRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDYixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxlQUFlLENBQUMsQ0FBQyxDQUFDO0FBQ2xDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLG9CQUFvQixDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3ZFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUM7QUFDdkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsb0JBQW9CLENBQUMsTUFBTSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQztBQUM1RixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0RixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDWCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDckIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ25CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsZUFBZSxDQUFDLENBQUMsQ0FBQztBQUM1QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNULENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDUDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsS0FBSztBQUN2QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUM1QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxD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QyxlQUFlLENBQUMsQ0FBQyxRQUFRO0FBQ3JDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1osQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDVCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxhQUFhLENBQUMsQ0FBQztBQUNwQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTDtBQUNBLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM5QyxDQUFDLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxFQUFFLENBQUMsQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3RELENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUM7QUFDdEUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQy9CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUM7QUFDbEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0w7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEVBQUUsQ0FBQyxPQUFPO0FBQ3ZCLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzdELENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUN2RSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUM7QUFDdkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDO0FBQ3RDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQztBQUNoQixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDO0FBQ3ZCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUM7QUFDbEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0w7QUFDQSxDQUFDLENBQUMsTUFBTSxDQUFDLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBQ0Q7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNsQztBQUNBLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxLQUFLO0FBQ2YsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3RDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQztBQUNiLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3JCLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQztBQUM1QixDQUFDLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7QUFDeEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLFFBQVEsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEtBQUssQ0FBQyxDQUFDO0FBQ3pHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDO0FBQ0g7QUFDQSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLElBQUk7QUFDbEIsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFDNUUsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDO0FBQ3RDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFlBQVks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Q0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQ3pCLENBQUMsQ0FBQyxDQUFDLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDNUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDckMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDLENBQUM7QUFDRixDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3RDLENBQUMsQ0FBQyxDQUFDO0FBQ0g7QUFDQSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsRUFBRSxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEQsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDO0FBQy9ELENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUM3RixDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQzlELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0RixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2pFLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLE1BQU0sQ0FBQztBQUM3QyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsYUFBYSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQzdDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDM0MsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsV0FBVyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUM3RCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLFNBQVM7QUFDOUIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsZ0JBQWdCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2hDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQztBQUNyQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUM7QUFDNUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUM7QUFDdkQsQ0FBQyxDQUFDLENB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LENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDaEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDakUsQ0FBQyxDQUFDLENBQUM7QUFDSCxDQUFDLENBQUMsQ0FBQztBQUNIO0FBQ0EsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25ELEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ2pELENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQztBQUMvRCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDN0YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQztBQUM5RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxFQUFFLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDdEYsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxPQUFPLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUM7QUFDdkMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDeEQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUM3QyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO0FBQzNDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUM7QUFDdkQsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLEdBQUcsQ0FBQyxTQUFTO0FBQzlCLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLGFBQWEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDN0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQy9CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQztBQUN0QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQztBQUN2RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNOLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1gsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDckUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDO0FBQzlDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNSLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDO0FBQ2xCLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQyxJQUFJLENBQUMsY0FBYztBQUM3QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ1IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDdEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLElB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QyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDO0FBQ3BELENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxZQUFZLENBQUMsQ0FBQztBQUM3RixDQUFDLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDO0FBQzlELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsVUFBVSxDQUFDLEVBQUUsQ0FBQyxZQUFZLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0RixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FB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Q0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUM7QUFDeEIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUMvRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUMvRCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO0FBQ2QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ3pGLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUM7QUFDZCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQztBQUN0QixDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDMUYsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQztBQUNkLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQztBQUNkLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxjQUFjLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFDL0QsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0wsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsV0FBVyxDQUFDLEdBQUcsQ0FBQyxDQUFDLGNBQWMsQ0FBQyxDQUFDO0FBQ3pFLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzNFLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUNuQixDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUM3RCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDO0FBQ0g7QUFDQSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDO0FBQ25CLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN6RCxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUM7QUFDUCxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQztBQUNyRCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsWUFBWSxDQUFDLENBQUM7QUFDN0YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsV0FBVyxDQUFDLENBQUMsQ0FBQztBQUM5RCxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ3RFLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNMLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDO0FBQzFELENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxRQUFRLENBQUMsQ0FBQyxDQUFDO0FBQy9CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLEdBQUcsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxJQUFJLENBQUMsQ0FBQztBQUN6QyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxJQUFJO0FBQ2YsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNQLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDSixDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsRUFBRSxDQUFDLENBQUMsR0FBRyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRSxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUM7QUFDbkIsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUM7QUFDN0MsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLE1BQU0sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDO0FBQ0g7QUFDQSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUk7QUFDbkIsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsR0FBRyxDQUFDLE9BQU8sQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkQsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxDQUFDO0FBQ1AsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUM7QUFDNUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNKLENBQUMsQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLElBQUksQ0FBQyxRQUFRLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFlBQVksQ0FBQyxDQUFDO0FBQzdGLENBQUMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUM7QUFDOUQsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUN0RSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDTCxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQ0osQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLE1BQU0sQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLENBQUM7QUFDNUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDaEMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDO0FBQ25CLENBQUMsQ0FBQyxDQUFDLENBQUMsT0FBTyxDQUFDLEtBQUssQ0FBQyxDQUFDLElBQUksQ0FBQyxNQUFNLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQztBQUNuRCxDQUFDLENBQUMsQ0FBQyxDQUFDLEdBQUcsQ0FBQyxNQUFNLENBQUMsR0FBRyxDQUFDLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQztBQUNqRSxDQUFDLENBQUMsQ0FBQztBQUNILENBQUMsQ0FBQyxDQUFDO0FBQ0g7QUFDQSxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsUUFBUTtBQUNuQixNQUFNLENBQUMsTUFBTSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDM0IsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsTUFBTSxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxFQUFFLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDbkUsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLENBQUMsb0JBQW9CLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFdBQVcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBQzFFLENBQUMsQ0FBQyxPQUFPLENBQUMsR0FBRyxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsSUFBSSxDQUFDLFFBQVEsQ0FBQyxFQUFFLENBQUMsU0FBUyxDQUFDLFVBQVUsQ0FBQyxDQUFDLENBQUM7QUFDMUQsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEVBQUUsQ0FBQyxRQUFRLENBQUMsVUFBVSxDQUFDLENBQUMsQ0FBQztBQUN6RCxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztBQUMzRCxDQUFDLENBQUMsT0FBTyxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxDQUFDLFFBQVEsQ0FBQyxVQUFVLENBQUMsQ0FBQyxDQUFDO0FBQ2xELENBQUMsQ0FBQyxDQUFDOyJ9
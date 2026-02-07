import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('='.repeat(60));
console.log('[INIT] 🚀 Baileys Server v2.9.6 iniciando...');
console.log('[INIT] 📦 Baileys 7.0.0-rc.9 (ESM)');
console.log('[INIT] 🔧 Sincronização completa com fotos de perfil');
console.log('[INIT] Node version:', process.version);
console.log('='.repeat(60));

const VERSION = "v2.9.6";
const app = express();

app.use(cors());
app.use(express.json());

// ============ CONFIGURAÇÃO ============
const WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || '';
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
const MAX_RETRIES = 3;
const QR_LOCK_TIME_MS = 60000;  // 60s - tempo para escanear QR
const RETRY_DELAY_MS = 15000;   // 15s entre retries

console.log('[CONFIG] Webhook URL:', WEBHOOK_URL ? 'Configurada ✓' : 'NÃO configurada ⚠');
console.log('[CONFIG] QR Lock Time:', QR_LOCK_TIME_MS / 1000, 's');
console.log('[CONFIG] Retry Delay:', RETRY_DELAY_MS / 1000, 's');

try {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log('[CONFIG] ✓ Pasta sessions criada');
  }
} catch (err) {
  console.error('[CONFIG] ❌ Erro ao criar pasta sessions:', err.message);
}

// ============ VARIÁVEIS GLOBAIS ============
const sessions = new Map();
let makeWASocket = null;
let useMultiFileAuthState = null;
let DisconnectReason = null;
let Browsers = null;
let QRCode = null;
let pino = null;
let baileysLoaded = false;

// ============ WEBHOOK ============
async function sendWebhook(payload) {
  if (!WEBHOOK_URL) return;
  try {
    const response = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    console.log(`[WEBHOOK] ${payload.event} - Status: ${response.status}`);
  } catch (error) {
    console.error('[WEBHOOK] Erro:', error.message);
  }
}

// ============ SLEEP ============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ BUSCAR FOTO DE PERFIL ============
async function getProfilePicture(sock, jid) {
  try {
    const ppUrl = await sock.profilePictureUrl(jid, 'image');
    return ppUrl;
  } catch (e) {
    // Sem foto de perfil (privacidade ou não existe)
    return null;
  }
}

// ============ CRIAR SOCKET (v2.9.6 - Com sync de fotos) ============
async function createSocketForSession(session) {
  const { sessionId, instanceName } = session;
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  
  // ===== CHECK QR LOCK =====
  if (session.qrGeneratedAt) {
    const timeSinceQR = Date.now() - session.qrGeneratedAt;
    if (timeSinceQR < QR_LOCK_TIME_MS) {
      const remaining = Math.ceil((QR_LOCK_TIME_MS - timeSinceQR) / 1000);
      console.log(`[QR LOCK] ⏳ QR gerado há ${Math.ceil(timeSinceQR/1000)}s, aguarde mais ${remaining}s`);
      return session;
    }
  }
  
  console.log('');
  console.log('[SOCKET] ========================================');
  console.log(`[SOCKET] Criando socket para: ${instanceName}`);
  console.log(`[SOCKET] Tentativa: ${session.retryCount + 1}/${MAX_RETRIES}`);
  console.log('[SOCKET] ========================================');
  
  // Fechar socket anterior se existir
  if (session.socket) {
    try {
      session.socket.end();
      console.log('[SOCKET] ✓ Socket anterior fechado');
    } catch (e) {}
    session.socket = null;
  }
  
  // Limpar auth em retry (mas não na primeira vez)
  if (session.retryCount > 0) {
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('[SOCKET] ✓ Auth antiga removida');
      }
      await sleep(3000);
    } catch (e) {
      console.error('[SOCKET] ⚠ Erro ao limpar auth:', e.message);
    }
  }
  
  // Criar diretório
  try {
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    console.log('[SOCKET] ✓ Diretório pronto');
  } catch (e) {
    console.error('[SOCKET] ❌ Erro ao criar diretório:', e.message);
    throw e;
  }
  
  // Carregar auth state
  console.log('[SOCKET] Carregando auth state...');
  let state, saveCreds;
  try {
    const authResult = await useMultiFileAuthState(sessionPath);
    state = authResult.state;
    saveCreds = authResult.saveCreds;
    console.log('[SOCKET] ✓ Auth state carregado');
  } catch (e) {
    console.error('[SOCKET] ❌ Erro no auth state:', e.message);
    throw e;
  }
  
  await sleep(1000);
  
  // ========== CRIAR SOCKET - v2.9.6 Config ==========
  console.log('[SOCKET] Criando socket com config v2.9.6...');
  
  const logger = pino({ level: 'silent' });
  
  // CONFIGURAÇÃO v2.9.6 - Com sincronização completa
  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
    logger: logger,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: false,
    retryRequestDelayMs: 2000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    getMessage: async () => undefined
  });
  
  session.socket = sock;
  session.socketCreatedAt = Date.now();
  console.log('[SOCKET] ✓ Socket criado!');
  
  // ========== REGISTRAR LISTENERS ==========
  console.log('[SOCKET] Registrando listeners...');
  
  sock.ev.on('creds.update', saveCreds);
  console.log('[SOCKET] ✓ creds.update registrado');
  
  // CONNECTION UPDATE
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    
    console.log('[CONNECTION] Update:', JSON.stringify({
      hasQr: !!qr,
      connection: connection || null,
      qrLocked: session.qrGeneratedAt ? (Date.now() - session.qrGeneratedAt < QR_LOCK_TIME_MS) : false
    }));
    
    if (qr) {
      console.log('[QR] 🎉 QR Code recebido!');
      try {
        session.qrCode = await QRCode.toDataURL(qr);
        session.qrGeneratedAt = Date.now();
        session.status = 'waiting_qr';
        console.log('[QR] ✅ QR Code convertido para DataURL');
        
        await sendWebhook({
          event: 'qr.update',
          sessionId,
          instanceName,
          data: { qrCode: session.qrCode }
        });
      } catch (e) {
        console.error('[QR] ❌ Erro ao converter:', e.message);
      }
    }
    
    if (connection === 'open') {
      session.isConnected = true;
      session.wasConnected = true;
      session.retryCount = 0;
      session.qrCode = null;
      session.qrGeneratedAt = null;
      session.status = 'connected';
      
      const user = sock.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || null;
      }
      
      // Buscar foto de perfil do próprio usuário
      try {
        session.profilePicture = await getProfilePicture(sock, sock.user?.id);
      } catch (e) {}
      
      console.log('');
      console.log('[CONNECTED] ✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅');
      console.log(`[CONNECTED] ${instanceName} CONECTADO!`);
      console.log(`[CONNECTED] Telefone: ${session.phoneNumber}`);
      console.log('[CONNECTED] ✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅✅');
      console.log('');
      
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
      });
    }
    
    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errorMessage = lastDisconnect?.error?.message || '';
      
      console.log('');
      console.log('[DISCONNECTED] ========================================');
      console.log(`[DISCONNECTED] Instância: ${instanceName}`);
      console.log(`[DISCONNECTED] Código: ${statusCode}`);
      console.log('[DISCONNECTED] ========================================');
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: { connection: 'close', isConnected: false, statusCode }
      });
      
      if (statusCode === DisconnectReason?.loggedOut) {
        console.log('[LOGOUT] Usuário fez logout, removendo sessão');
        session.status = 'logged_out';
        sessions.delete(sessionId);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (e) {}
        return;
      }
      
      if (statusCode === 515 || statusCode === DisconnectReason?.restartRequired) {
        console.log('[515] ⚡ PAREAMENTO DETECTADO - Reconexão IMEDIATA');
        session.qrGeneratedAt = null;
        session.qrCode = null;
        session.status = 'reconnecting_after_pair';
        
        if (session.socket) {
          try { session.socket.end(); } catch (e) {}
          session.socket = null;
        }
        
        setTimeout(async () => {
          try {
            console.log('[515] 🔄 Iniciando reconexão...');
            await createSocketForSession(session);
          } catch (err) {
            console.error('[515] ❌ Erro na reconexão:', err.message);
            session.status = 'failed';
          }
        }, 1000);
        return;
      }
      
      if (session.qrGeneratedAt) {
        const timeSinceQR = Date.now() - session.qrGeneratedAt;
        if (timeSinceQR < QR_LOCK_TIME_MS) {
          console.log('[QR LOCK] ⏳ QR ativo, NÃO reconectando');
          return;
        }
      }
      
      if (statusCode === 405 || statusCode === 408) {
        session.retryCount++;
        if (session.retryCount < MAX_RETRIES) {
          session.qrCode = null;
          session.qrGeneratedAt = null;
          session.status = 'reconnecting';
          setTimeout(async () => {
            try {
              await createSocketForSession(session);
            } catch (err) {
              session.status = 'failed';
            }
          }, RETRY_DELAY_MS);
        } else {
          session.status = 'failed';
        }
        return;
      }
      
      if (session.retryCount < MAX_RETRIES) {
        session.retryCount++;
        session.status = 'reconnecting';
        setTimeout(async () => {
          try {
            await createSocketForSession(session);
          } catch (err) {
            session.status = 'failed';
          }
        }, RETRY_DELAY_MS);
      } else {
        session.status = 'failed';
      }
    }
  });
  console.log('[SOCKET] ✓ connection.update registrado');
  
  // MENSAGENS (novas e histórico)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`[MESSAGES] Tipo: ${type}, Quantidade: ${messages.length}`);
    
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.message?.protocolMessage) continue;
      
      // Buscar foto de perfil do remetente
      let profilePicture = null;
      if (!msg.key.fromMe && msg.key.remoteJid) {
        profilePicture = await getProfilePicture(sock, msg.key.remoteJid);
      }
      
      console.log(`[MESSAGE] De: ${msg.key.remoteJid} | FromMe: ${msg.key.fromMe}`);
      
      await sendWebhook({
        event: 'messages.upsert',
        sessionId,
        instanceName,
        data: {
          type,
          messages: [{
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName,
            profilePicture
          }]
        }
      });
    }
  });
  console.log('[SOCKET] ✓ messages.upsert registrado');
  
  // MESSAGING HISTORY SET (histórico completo de mensagens)
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }) => {
    console.log(`[HISTORY] 📥 Histórico recebido: ${chats?.length || 0} chats, ${contacts?.length || 0} contatos, ${messages?.length || 0} msgs`);
    
    // Processar chats com fotos de perfil
    if (chats && chats.length > 0) {
      const enrichedChats = [];
      for (const chat of chats) {
        const jid = chat.id || chat.jid;
        if (!jid || jid === 'status@broadcast' || jid.includes('@g.us')) continue;
        
        let profilePicture = null;
        try {
          profilePicture = await getProfilePicture(sock, jid);
        } catch (e) {}
        
        enrichedChats.push({
          ...chat,
          profilePicture
        });
      }
      
      console.log(`[HISTORY] 📸 Buscou fotos de ${enrichedChats.length} chats`);
      
      await sendWebhook({
        event: 'chats.set',
        sessionId,
        instanceName,
        data: { chats: enrichedChats, isLatest }
      });
    }
    
    // Processar contatos
    if (contacts && contacts.length > 0) {
      const enrichedContacts = [];
      for (const contact of contacts) {
        const jid = contact.id || contact.jid;
        if (!jid || jid.includes('@g.us')) continue;
        
        let profilePicture = null;
        try {
          profilePicture = await getProfilePicture(sock, jid);
        } catch (e) {}
        
        enrichedContacts.push({
          ...contact,
          profilePicture
        });
      }
      
      console.log(`[HISTORY] 📸 Buscou fotos de ${enrichedContacts.length} contatos`);
      
      await sendWebhook({
        event: 'contacts.upsert',
        sessionId,
        instanceName,
        data: { contacts: enrichedContacts }
      });
    }
  });
  console.log('[SOCKET] ✓ messaging-history.set registrado');
  
  // CHATS UPSERT (incremental)
  sock.ev.on('chats.upsert', async (chats) => {
    console.log(`[CHATS] 📥 ${chats.length} chats sincronizados!`);
    
    const enrichedChats = [];
    for (const chat of chats) {
      const jid = chat.id || chat.jid;
      if (!jid || jid === 'status@broadcast' || jid.includes('@g.us')) continue;
      
      let profilePicture = null;
      try {
        profilePicture = await getProfilePicture(sock, jid);
      } catch (e) {}
      
      enrichedChats.push({
        ...chat,
        profilePicture
      });
    }
    
    await sendWebhook({
      event: 'chats.upsert',
      sessionId,
      instanceName,
      data: { chats: enrichedChats }
    });
  });
  console.log('[SOCKET] ✓ chats.upsert registrado');
  
  // CHATS SET (full sync)
  sock.ev.on('chats.set', async ({ chats, isLatest }) => {
    console.log(`[CHATS SET] 📥 ${chats.length} chats (isLatest: ${isLatest})`);
    
    const enrichedChats = [];
    for (const chat of chats) {
      const jid = chat.id || chat.jid;
      if (!jid || jid === 'status@broadcast' || jid.includes('@g.us')) continue;
      
      let profilePicture = null;
      try {
        profilePicture = await getProfilePicture(sock, jid);
      } catch (e) {}
      
      enrichedChats.push({
        ...chat,
        profilePicture
      });
    }
    
    await sendWebhook({
      event: 'chats.set',
      sessionId,
      instanceName,
      data: { chats: enrichedChats, isLatest }
    });
  });
  console.log('[SOCKET] ✓ chats.set registrado');
  
  // CONTATOS UPSERT
  sock.ev.on('contacts.upsert', async (contacts) => {
    console.log(`[CONTACTS] 📥 ${contacts.length} contatos sincronizados!`);
    
    const enrichedContacts = [];
    for (const contact of contacts) {
      const jid = contact.id || contact.jid;
      if (!jid || jid.includes('@g.us')) continue;
      
      let profilePicture = null;
      try {
        profilePicture = await getProfilePicture(sock, jid);
      } catch (e) {}
      
      enrichedContacts.push({
        ...contact,
        profilePicture
      });
    }
    
    await sendWebhook({
      event: 'contacts.upsert',
      sessionId,
      instanceName,
      data: { contacts: enrichedContacts }
    });
  });
  console.log('[SOCKET] ✓ contacts.upsert registrado');
  
  // CONTATOS SET
  sock.ev.on('contacts.set', async ({ contacts }) => {
    console.log(`[CONTACTS SET] 📥 ${contacts.length} contatos`);
    
    const enrichedContacts = [];
    for (const contact of contacts) {
      const jid = contact.id || contact.jid;
      if (!jid || jid.includes('@g.us')) continue;
      
      let profilePicture = null;
      try {
        profilePicture = await getProfilePicture(sock, jid);
      } catch (e) {}
      
      enrichedContacts.push({
        ...contact,
        profilePicture
      });
    }
    
    await sendWebhook({
      event: 'contacts.set',
      sessionId,
      instanceName,
      data: { contacts: enrichedContacts }
    });
  });
  console.log('[SOCKET] ✓ contacts.set registrado');
  
  console.log('[SOCKET] ========================================');
  console.log('[SOCKET] ✅ Socket v2.9.6 pronto, aguardando QR...');
  console.log('[SOCKET] ========================================');
  console.log('');
  
  return session;
}

// ============ CRIAR SESSÃO ============
async function createSession(sessionId, instanceName, webhookSecret) {
  if (!baileysLoaded) {
    throw new Error('Baileys ainda não carregado');
  }
  
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    console.log(`[SESSION] ${sessionId} já existe (status: ${existing.status})`);
    return existing;
  }

  console.log(`[SESSION] ========== NOVA SESSÃO: ${instanceName} ==========`);

  const session = {
    sessionId,
    instanceName,
    socket: null,
    webhookSecret,
    qrCode: null,
    qrGeneratedAt: null,
    isConnected: false,
    wasConnected: false,
    retryCount: 0,
    createdAt: Date.now(),
    socketCreatedAt: null,
    phoneNumber: null,
    pushName: null,
    status: 'initializing'
  };

  sessions.set(sessionId, session);
  await createSocketForSession(session);
  return session;
}

// ============ ROTAS ============

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: VERSION,
    baileys: '7.0.0-rc.9',
    browser: 'Browsers.macOS("Desktop")',
    qrLockTime: QR_LOCK_TIME_MS / 1000 + 's',
    retryDelay: RETRY_DELAY_MS / 1000 + 's',
    sessions: sessions.size,
    baileysLoaded,
    timestamp: new Date().toISOString()
  });
});

app.post('/api/instance/create', async (req, res) => {
  try {
    if (!baileysLoaded) {
      return res.status(503).json({ error: 'Baileys carregando...' });
    }
    
    const { sessionId, instanceName, webhookSecret } = req.body;
    
    if (!sessionId || !instanceName) {
      return res.status(400).json({ error: 'sessionId e instanceName obrigatórios' });
    }
    
    console.log(`[${VERSION}] Criando: ${instanceName}`);
    const session = await createSession(sessionId, instanceName, webhookSecret || '');
    
    res.json({
      success: true,
      version: VERSION,
      sessionId: session.sessionId,
      instanceName: session.instanceName,
      isConnected: session.isConnected,
      status: session.status
    });
  } catch (error) {
    console.error('[ERROR] Criar:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/instance/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  // Info sobre QR Lock
  let qrLockRemaining = null;
  if (session.qrGeneratedAt) {
    const elapsed = Date.now() - session.qrGeneratedAt;
    if (elapsed < QR_LOCK_TIME_MS) {
      qrLockRemaining = Math.ceil((QR_LOCK_TIME_MS - elapsed) / 1000);
    }
  }
  
  res.json({
    qrCode: session.qrCode,
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    status: session.status,
    qrLockRemaining
  });
});

app.get('/api/instance/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada', status: 'not_found' });
  }
  
  res.json({
    status: session.status,
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    wasConnected: session.wasConnected,
    retryCount: session.retryCount,
    hasQR: !!session.qrCode
  });
});

app.post('/api/instance/:sessionId/regenerate-qr', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  console.log(`[REGENERATE] ${session.instanceName}`);
  
  // Fechar socket atual
  if (session.socket) {
    try { session.socket.end(); } catch (e) {}
  }
  
  // Resetar estado INCLUINDO qrGeneratedAt para permitir reconexão
  session.socket = null;
  session.qrCode = null;
  session.qrGeneratedAt = null;  // IMPORTANTE: limpar lock
  session.retryCount = 0;
  session.status = 'initializing';
  session.wasConnected = false;
  
  // Limpar auth
  const sessionPath = path.join(SESSIONS_DIR, session.sessionId);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('[REGENERATE] ✓ Auth limpa');
  } catch (e) {}
  
  await sleep(2000);
  
  try {
    await createSocketForSession(session);
    res.json({ success: true, message: 'Regenerando QR...', status: session.status });
  } catch (error) {
    console.error('[REGENERATE] Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/instance/list', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      sessionId: id,
      instanceName: session.instanceName,
      isConnected: session.isConnected,
      phoneNumber: session.phoneNumber,
      status: session.status,
      hasQR: !!session.qrCode
    });
  }
  res.json({ sessions: list });
});

app.delete('/api/instance/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' });
  }
  
  if (session.socket) {
    try { await session.socket.logout(); } catch (e) {
      try { session.socket.end(); } catch (e2) {}
    }
  }
  
  const sessionPath = path.join(SESSIONS_DIR, session.sessionId);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true });
  }
  
  sessions.delete(req.params.sessionId);
  res.json({ success: true });
});

app.post('/api/message/send-text', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const session = sessions.get(sessionId);
    
    if (!session || !session.socket || !session.isConnected) {
      return res.status(400).json({ error: 'Sessão não conectada' });
    }
    
    let jid = phone.replace(/\D/g, '');
    if (!jid.includes('@')) {
      jid = jid + '@s.whatsapp.net';
    }
    
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (error) {
    console.error('[ERROR] Enviar:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ INICIAR SERVIDOR ============
const PORT = process.env.PORT || 3333;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('='.repeat(60));
  console.log(`🚀 [${VERSION}] Servidor HTTP na porta ${PORT}`);
  console.log(`📡 Webhook: ${WEBHOOK_URL || 'Não configurada'}`);
  console.log(`📦 Baileys: 7.0.0-rc.9 (ESM)`);
  console.log(`🔒 QR Lock: ${QR_LOCK_TIME_MS/1000}s`);
  console.log(`⏱️ Retry Delay: ${RETRY_DELAY_MS/1000}s`);
  console.log('='.repeat(60));
  console.log('');
  loadBaileys();
});

// ============ CARREGAR BAILEYS (ESM) ==========
async function loadBaileys() {
  console.log('[BAILEYS] ========================================');
  console.log('[BAILEYS] Carregando Baileys 7.0.0-rc.9 (ESM)...');
  console.log('[BAILEYS] ========================================');
  
  try {
    // Importar módulos ESM
    const qrcodeModule = await import('qrcode');
    QRCode = qrcodeModule.default;
    console.log('[BAILEYS] ✓ qrcode');
    
    const pinoModule = await import('pino');
    pino = pinoModule.default;
    console.log('[BAILEYS] ✓ pino');
    
    console.log('[BAILEYS] Importando @whiskeysockets/baileys 7.x...');
    const baileys = await import('@whiskeysockets/baileys');
    
    // Baileys 7.x exports
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    Browsers = baileys.Browsers;
    
    console.log('[BAILEYS] ✓ makeWASocket:', typeof makeWASocket);
    console.log('[BAILEYS] ✓ useMultiFileAuthState:', typeof useMultiFileAuthState);
    console.log('[BAILEYS] ✓ DisconnectReason:', typeof DisconnectReason);
    console.log('[BAILEYS] ✓ Browsers:', typeof Browsers);
    
    if (!makeWASocket || !useMultiFileAuthState || !Browsers) {
      console.log('[BAILEYS] Exports disponíveis:', Object.keys(baileys));
      throw new Error('Exports do Baileys 7.x não encontrados');
    }
    
    // Testar Browsers.macOS
    const browserTest = Browsers.macOS("Desktop");
    console.log('[BAILEYS] ✓ Browsers.macOS("Desktop"):', JSON.stringify(browserTest));
    
    baileysLoaded = true;
    
    console.log('');
    console.log('[BAILEYS] ========================================');
    console.log('[BAILEYS] ✅ BAILEYS 7.0.0-rc.9 PRONTO!');
    console.log('[BAILEYS] 🔒 QR Lock:', QR_LOCK_TIME_MS/1000, 's');
    console.log('[BAILEYS] ========================================');
    console.log('');
  } catch (err) {
    console.error('[BAILEYS] ❌ ERRO:', err.message);
    console.error('[BAILEYS] Stack:', err.stack);
  }
}

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Recebido SIGTERM');
  server.close(() => {
    console.log('[SHUTDOWN] Fechado');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled:', reason);
});

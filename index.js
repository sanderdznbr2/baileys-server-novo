const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

console.log('='.repeat(60));
console.log('[INIT] 🚀 Baileys Server v2.6.0 iniciando...');
console.log('[INIT] ⚠️  Usando Baileys 6.5.0 (versão estável)');
console.log('[INIT] Node version:', process.version);
console.log('[INIT] Platform:', process.platform);
console.log('[INIT] PORT:', process.env.PORT || 3333);
console.log('='.repeat(60));

const VERSION = "v2.6.0";
const app = express();

app.use(cors());
app.use(express.json());

// ============ CONFIGURAÇÃO ============
const WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || '';
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
const MAX_RETRIES = 3;

console.log('[CONFIG] Webhook URL:', WEBHOOK_URL ? 'Configurada ✓' : 'NÃO configurada ⚠');
console.log('[CONFIG] Sessions dir:', SESSIONS_DIR);

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

// ============ CRIAR SOCKET (v2.6.0 - SIMPLIFICADO) ============
async function createSocketForSession(session) {
  const { sessionId, instanceName } = session;
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  
  console.log('');
  console.log('[SOCKET] ========================================');
  console.log(`[SOCKET] Criando socket para: ${instanceName}`);
  console.log(`[SOCKET] Tentativa: ${session.retryCount + 1}/${MAX_RETRIES}`);
  console.log('[SOCKET] ========================================');
  
  // Limpar auth em retry
  if (session.retryCount > 0) {
    try {
      if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('[SOCKET] ✓ Auth antiga removida');
      }
      await sleep(2000);
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
  
  // ========== CRIAR SOCKET - CONFIGURAÇÃO MÍNIMA ==========
  console.log('[SOCKET] Criando socket com config MÍNIMA...');
  
  const logger = pino({ level: 'silent' });
  
  // APENAS 3 OPÇÕES - Isso é o que funciona no 6.5.0
  const sock = makeWASocket({
    printQRInTerminal: true,
    auth: state,
    logger: logger
  });
  
  session.socket = sock;
  session.socketCreatedAt = Date.now();
  console.log('[SOCKET] ✓ Socket criado!');
  
  // ========== REGISTRAR LISTENERS ==========
  console.log('[SOCKET] Registrando listeners...');
  
  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);
  console.log('[SOCKET] ✓ creds.update registrado');
  
  // CONNECTION UPDATE - Principal handler
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    
    console.log('[CONNECTION] Update:', JSON.stringify({
      hasQr: !!qr,
      connection: connection || null
    }));
    
    // ===== QR CODE =====
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
    
    // ===== CONECTADO =====
    if (connection === 'open') {
      session.isConnected = true;
      session.wasConnected = true;
      session.retryCount = 0;
      session.qrCode = null;
      session.status = 'connected';
      
      const user = sock.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || null;
      }
      
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
          pushName: session.pushName
        }
      });
    }
    
    // ===== DESCONECTADO =====
    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      
      console.log('');
      console.log('[DISCONNECTED] ========================================');
      console.log(`[DISCONNECTED] Instância: ${instanceName}`);
      console.log(`[DISCONNECTED] Código: ${statusCode}`);
      console.log(`[DISCONNECTED] wasConnected: ${session.wasConnected}`);
      console.log(`[DISCONNECTED] hadQR: ${!!session.qrCode}`);
      console.log('[DISCONNECTED] ========================================');
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: { connection: 'close', isConnected: false, statusCode }
      });
      
      // Logout = não reconectar
      if (statusCode === DisconnectReason?.loggedOut) {
        console.log('[LOGOUT] Usuário fez logout');
        session.status = 'logged_out';
        sessions.delete(sessionId);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (e) {}
        return;
      }
      
      // Tentar reconectar
      if (session.retryCount < MAX_RETRIES) {
        session.retryCount++;
        session.status = 'reconnecting';
        
        console.log(`[RETRY] Tentativa ${session.retryCount}/${MAX_RETRIES} em 5s...`);
        
        setTimeout(async () => {
          try {
            await createSocketForSession(session);
          } catch (err) {
            console.error('[RETRY] Erro:', err.message);
            session.status = 'failed';
          }
        }, 5000);
      } else {
        console.log('[FAILED] Esgotou tentativas');
        session.status = 'failed';
      }
    }
  });
  console.log('[SOCKET] ✓ connection.update registrado');
  
  // MENSAGENS
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      
      console.log(`[MESSAGE] De: ${msg.key.remoteJid}`);
      
      await sendWebhook({
        event: 'messages.upsert',
        sessionId,
        instanceName,
        data: {
          messages: [{
            key: msg.key,
            message: msg.message,
            messageTimestamp: msg.messageTimestamp,
            pushName: msg.pushName
          }]
        }
      });
    }
  });
  console.log('[SOCKET] ✓ messages.upsert registrado');
  
  console.log('[SOCKET] ========================================');
  console.log('[SOCKET] ✅ Socket pronto, aguardando QR...');
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
    baileys: '6.5.0',
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
      baileys: '6.5.0',
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
  
  res.json({
    qrCode: session.qrCode,
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    status: session.status
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
  
  // Resetar estado
  session.socket = null;
  session.qrCode = null;
  session.qrGeneratedAt = null;
  session.retryCount = 0;
  session.status = 'initializing';
  session.wasConnected = false;
  
  // Limpar auth
  const sessionPath = path.join(SESSIONS_DIR, session.sessionId);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('[REGENERATE] ✓ Auth limpa');
  } catch (e) {}
  
  await sleep(1000);
  
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
  console.log(`📦 Baileys: 6.5.0 (versão estável)`);
  console.log('='.repeat(60));
  console.log('');
  loadBaileys();
});

// ============ CARREGAR BAILEYS 6.5.0 ============
async function loadBaileys() {
  console.log('[BAILEYS] ========================================');
  console.log('[BAILEYS] Carregando Baileys 6.5.0...');
  console.log('[BAILEYS] ========================================');
  
  try {
    QRCode = require('qrcode');
    console.log('[BAILEYS] ✓ qrcode');
    
    pino = require('pino');
    console.log('[BAILEYS] ✓ pino');
    
    console.log('[BAILEYS] Importando @whiskeysockets/baileys 6.5.0...');
    const baileys = await import('@whiskeysockets/baileys');
    
    // Baileys 6.5.0 tem estrutura diferente
    if (typeof baileys.default === 'function') {
      makeWASocket = baileys.default;
      console.log('[BAILEYS] ✓ makeWASocket via default');
    } else if (baileys.default && typeof baileys.default.default === 'function') {
      makeWASocket = baileys.default.default;
      console.log('[BAILEYS] ✓ makeWASocket via default.default');
    } else if (typeof baileys.makeWASocket === 'function') {
      makeWASocket = baileys.makeWASocket;
      console.log('[BAILEYS] ✓ makeWASocket via named export');
    } else {
      console.log('[BAILEYS] Exports disponíveis:', Object.keys(baileys));
      console.log('[BAILEYS] Default type:', typeof baileys.default);
      if (baileys.default) {
        console.log('[BAILEYS] Default keys:', Object.keys(baileys.default));
      }
      throw new Error('makeWASocket não encontrado');
    }
    
    // Funções auxiliares
    useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;
    
    console.log('[BAILEYS] ✓ useMultiFileAuthState:', typeof useMultiFileAuthState);
    console.log('[BAILEYS] ✓ DisconnectReason:', typeof DisconnectReason);
    
    if (!useMultiFileAuthState) {
      throw new Error('useMultiFileAuthState não encontrado');
    }
    
    baileysLoaded = true;
    
    console.log('');
    console.log('[BAILEYS] ========================================');
    console.log('[BAILEYS] ✅ BAILEYS 6.5.0 PRONTO!');
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

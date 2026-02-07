const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

console.log('='.repeat(50));
console.log('[INIT] Baileys Server iniciando...');
console.log('[INIT] Node version:', process.version);
console.log('[INIT] PORT:', process.env.PORT || 3333);
console.log('='.repeat(50));

const VERSION = "v2.2.0";
const app = express();

app.use(cors());
app.use(express.json());

// ============ CONFIGURAÇÃO ============
const WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || '';
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');

console.log('[CONFIG] Webhook URL:', WEBHOOK_URL ? 'Configurada' : 'NÃO configurada');
console.log('[CONFIG] Sessions dir:', SESSIONS_DIR);

try {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    console.log('[CONFIG] Pasta sessions criada');
  }
} catch (err) {
  console.error('[CONFIG] Erro ao criar pasta sessions:', err.message);
}

// ============ VARIÁVEIS GLOBAIS ============
const sessions = new Map();
let makeWASocket = null;
let useMultiFileAuthState = null;
let DisconnectReason = null;
let makeCacheableSignalKeyStore = null;
let fetchLatestBaileysVersion = null;
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

// ============ CRIAR SESSÃO WHATSAPP ============
async function createSession(sessionId, instanceName, webhookSecret) {
  if (!baileysLoaded) {
    throw new Error('Baileys ainda não carregado, aguarde alguns segundos');
  }
  
  if (sessions.has(sessionId)) {
    console.log(`[SESSION] ${sessionId} já existe`);
    return sessions.get(sessionId);
  }

  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  
  console.log(`[SESSION] Criando ${instanceName} (Baileys v${version.join('.')})`);

  // v2.2.0: Adicionar flags para controle de reconexão
  const session = {
    sessionId,
    instanceName,
    socket: null,
    webhookSecret,
    qrCode: null,
    isConnected: false,
    wasConnected: false,  // NOVO: rastreia se já conectou alguma vez
    retryCount: 0,        // NOVO: conta tentativas de reconexão
    createdAt: Date.now(), // NOVO: timestamp de criação
    phoneNumber: null,
    pushName: null
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
    browser: ['Ellosuit CRM', 'Chrome', '120.0.0']
  });

  session.socket = socket;
  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      session.qrCode = await QRCode.toDataURL(qr);
      console.log(`[QR] Gerado para ${instanceName}`);
      await sendWebhook({
        event: 'qr.update',
        sessionId,
        instanceName,
        data: { qrCode: session.qrCode }
      });
    }

    if (connection === 'open') {
      session.isConnected = true;
      session.wasConnected = true;  // v2.2.0: Marca que já conectou
      session.retryCount = 0;       // v2.2.0: Reset contador
      session.qrCode = null;
      const user = socket.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || null;
      }
      console.log(`[CONNECTED] ${instanceName} - ${session.phoneNumber}`);
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: { connection: 'open', isConnected: true, phoneNumber: session.phoneNumber, pushName: session.pushName }
      });
    }

    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      
      // v2.2.0: LÓGICA CORRIGIDA - Só reconectar se já tinha conectado antes
      const shouldReconnect = 
        session.wasConnected && 
        statusCode !== DisconnectReason?.loggedOut &&
        session.retryCount < 5;
      
      console.log(`[DISCONNECTED] ${instanceName} - Code: ${statusCode}, wasConnected: ${session.wasConnected}, retryCount: ${session.retryCount}, shouldReconnect: ${shouldReconnect}`);
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: { connection: 'close', isConnected: false, statusCode }
      });
      
      if (shouldReconnect) {
        // v2.2.0: Só reconectar se já tinha conectado antes
        session.retryCount++;
        console.log(`[RECONNECT] Tentando reconectar ${instanceName} em 3s... (tentativa ${session.retryCount}/5)`);
        setTimeout(async () => {
          try {
            sessions.delete(sessionId);
            await createSession(sessionId, instanceName, webhookSecret);
          } catch (err) {
            console.error(`[RECONNECT] Erro ao reconectar ${instanceName}:`, err.message);
          }
        }, 3000);
      } else if (statusCode === DisconnectReason?.loggedOut) {
        // Logout explícito - remover sessão
        console.log(`[LOGOUT] ${instanceName} fez logout, removendo sessão`);
        sessions.delete(sessionId);
        try {
          const sessionPath = path.join(SESSIONS_DIR, sessionId);
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (e) {}
      } else if (!session.wasConnected) {
        // v2.2.0: Nunca conectou - MANTER sessão ativa esperando QR ser escaneado
        console.log(`[WAITING] ${instanceName} aguardando QR ser escaneado (não deletar sessão)`);
        // NÃO deletar a sessão! Manter ativa para que o QR possa ser escaneado
      }
    }
  });

  socket.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      console.log(`[MESSAGE] De ${msg.key.remoteJid}`);
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

  socket.ev.on('messages.update', async (updates) => {
    await sendWebhook({ event: 'messages.update', sessionId, instanceName, data: { updates } });
  });

  return session;
}

// ============ ROTAS ============

// Health check
app.get('/api/health', (req, res) => {
  console.log(`[${VERSION}] Health check`);
  res.json({ 
    status: 'ok', 
    version: VERSION, 
    sessions: sessions.size, 
    baileysLoaded,
    timestamp: new Date().toISOString() 
  });
});

// Criar instância
app.post('/api/instance/create', async (req, res) => {
  try {
    if (!baileysLoaded) {
      return res.status(503).json({ error: 'Baileys ainda carregando, aguarde alguns segundos...' });
    }
    const { sessionId, instanceName, webhookSecret } = req.body;
    if (!sessionId || !instanceName) {
      return res.status(400).json({ error: 'sessionId e instanceName são obrigatórios' });
    }
    console.log(`[${VERSION}] Criando instância: ${instanceName}`);
    const session = await createSession(sessionId, instanceName, webhookSecret || '');
    res.json({ success: true, version: VERSION, sessionId: session.sessionId, instanceName: session.instanceName, isConnected: session.isConnected });
  } catch (error) {
    console.error('[ERROR] Criar instância:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter QR Code
app.get('/api/instance/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  res.json({ qrCode: session.qrCode, isConnected: session.isConnected, phoneNumber: session.phoneNumber, pushName: session.pushName });
});

// Obter status
app.get('/api/instance/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada', status: 'not_found' });
  res.json({
    status: session.isConnected ? 'connected' : (session.qrCode ? 'waiting_qr' : 'connecting'),
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    wasConnected: session.wasConnected,
    retryCount: session.retryCount,
    sessionAge: Date.now() - session.createdAt
  });
});

// Listar sessões
app.get('/api/instance/list', (req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({ sessionId: id, instanceName: session.instanceName, isConnected: session.isConnected, phoneNumber: session.phoneNumber });
  }
  res.json({ sessions: list });
});

// Deletar sessão
app.delete('/api/instance/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  try {
    if (session.socket) await session.socket.logout();
  } catch (e) {
    console.log('[LOGOUT] Erro:', e.message);
  }
  const sessionPath = path.join(SESSIONS_DIR, session.sessionId);
  if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true });
  sessions.delete(req.params.sessionId);
  res.json({ success: true });
});

// Enviar mensagem de texto
app.post('/api/message/send-text', async (req, res) => {
  try {
    const { sessionId, phone, message } = req.body;
    const session = sessions.get(sessionId);
    if (!session || !session.socket || !session.isConnected) {
      return res.status(400).json({ error: 'Sessão não conectada' });
    }
    let jid = phone.replace(/\D/g, '');
    if (!jid.includes('@')) jid = jid + '@s.whatsapp.net';
    await session.socket.sendMessage(jid, { text: message });
    res.json({ success: true, to: jid });
  } catch (error) {
    console.error('[ERROR] Enviar mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============ INICIAR SERVIDOR ============
const PORT = process.env.PORT || 3333;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🚀 [${VERSION}] Servidor HTTP rodando na porta ${PORT}`);
  console.log(`📡 Webhook URL: ${WEBHOOK_URL || 'Não configurada'}`);
  console.log('='.repeat(50));
  
  loadBaileys();
});

async function loadBaileys() {
  console.log('[BAILEYS] Carregando módulos...');
  try {
    QRCode = require('qrcode');
    console.log('[BAILEYS] qrcode carregado ✓');
    
    pino = require('pino');
    console.log('[BAILEYS] pino carregado ✓');
    
    const baileys = await import('@whiskeysockets/baileys');
    console.log('[BAILEYS] Módulo importado, extraindo funções...');
    
    if (typeof baileys.default === 'function') {
      makeWASocket = baileys.default;
    } else if (baileys.default && typeof baileys.default.default === 'function') {
      makeWASocket = baileys.default.default;
    } else if (typeof baileys.makeWASocket === 'function') {
      makeWASocket = baileys.makeWASocket;
    } else {
      console.log('[BAILEYS] Estrutura do módulo:', Object.keys(baileys));
      console.log('[BAILEYS] Estrutura de baileys.default:', baileys.default ? Object.keys(baileys.default) : 'undefined');
      throw new Error('Não foi possível encontrar makeWASocket no módulo');
    }
    
    useMultiFileAuthState = baileys.useMultiFileAuthState || baileys.default?.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason || baileys.default?.DisconnectReason;
    makeCacheableSignalKeyStore = baileys.makeCacheableSignalKeyStore || baileys.default?.makeCacheableSignalKeyStore;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion || baileys.default?.fetchLatestBaileysVersion;
    
    if (!useMultiFileAuthState || !makeCacheableSignalKeyStore || !fetchLatestBaileysVersion) {
      throw new Error('Funções auxiliares do Baileys não encontradas');
    }
    
    baileysLoaded = true;
    console.log('[BAILEYS] @whiskeysockets/baileys carregado ✓');
    console.log('[BAILEYS] makeWASocket:', typeof makeWASocket);
    console.log('[BAILEYS] Pronto para criar sessões!');
  } catch (err) {
    console.error('[BAILEYS] ERRO ao carregar:', err.message);
    console.error('[BAILEYS] Stack:', err.stack);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Recebido SIGTERM, fechando...');
  server.close(() => {
    console.log('[SHUTDOWN] Servidor fechado');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

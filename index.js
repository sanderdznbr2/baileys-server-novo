const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

console.log('='.repeat(50));
console.log('[INIT] Baileys Server iniciando...');
console.log('[INIT] Node version:', process.version);
console.log('[INIT] PORT:', process.env.PORT || 3333);
console.log('='.repeat(50));

const VERSION = "v2.4.0";
const app = express();

app.use(cors());
app.use(express.json());

// ============ CONFIGURAÇÃO ============
const WEBHOOK_URL = process.env.SUPABASE_WEBHOOK_URL || '';
const SESSIONS_DIR = path.join(process.cwd(), 'sessions');
const MAX_QR_RETRIES = 5; // Aumentado para 5 tentativas
const RETRY_DELAYS = [3000, 5000, 8000, 12000, 15000]; // Delays progressivos

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
let Browsers = null;
let delay = null;
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

// ============ DELAY HELPER ============
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ CRIAR SOCKET PARA SESSÃO ============
async function createSocketForSession(session) {
  const { sessionId, instanceName, webhookSecret } = session;
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  
  // Limpar pasta de auth se existir e estamos recriando após falha
  if (session.qrRetryCount > 0) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`[SOCKET] Limpou auth antiga para ${instanceName}`);
    } catch (e) {}
    
    // Aguardar antes de recriar (delay progressivo)
    const delayMs = RETRY_DELAYS[Math.min(session.qrRetryCount - 1, RETRY_DELAYS.length - 1)];
    console.log(`[SOCKET] Aguardando ${delayMs/1000}s antes de recriar socket...`);
    await sleep(delayMs);
  }
  
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();
  
  console.log(`[SOCKET] Criando socket para ${instanceName} (Baileys v${version.join('.')}) - tentativa ${session.qrRetryCount + 1}/${MAX_QR_RETRIES}`);

  const logger = pino({ level: 'silent' });
  
  // v2.4.0: Configuração mais robusta do socket
  const socketConfig = {
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    // Browser string que funciona melhor
    browser: ['Ubuntu', 'Chrome', '120.0.6099.119'],
    // Timeouts aumentados
    connectTimeoutMs: 120000,
    defaultQueryTimeoutMs: 60000,
    qrTimeout: 60000,
    // Opções para evitar sobrecarga
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    // Retry interno desabilitado (controlamos manualmente)
    retryRequestDelayMs: 2000,
    maxMsgRetryCount: 1
  };
  
  console.log('[SOCKET] Config:', JSON.stringify({
    browser: socketConfig.browser,
    connectTimeoutMs: socketConfig.connectTimeoutMs,
    syncFullHistory: socketConfig.syncFullHistory
  }));

  const socket = makeWASocket(socketConfig);

  session.socket = socket;
  session.socketCreatedAt = Date.now();
  socket.ev.on('creds.update', saveCreds);

  socket.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      session.qrCode = await QRCode.toDataURL(qr);
      session.qrGeneratedAt = Date.now();
      session.status = 'waiting_qr';
      console.log(`[QR] ✅ Gerado para ${instanceName} (após ${session.qrRetryCount} retries)`);
      await sendWebhook({
        event: 'qr.update',
        sessionId,
        instanceName,
        data: { qrCode: session.qrCode }
      });
    }

    if (connection === 'open') {
      session.isConnected = true;
      session.wasConnected = true;
      session.qrRetryCount = 0;
      session.retryCount = 0;
      session.qrCode = null;
      session.status = 'connected';
      const user = socket.user;
      if (user) {
        session.phoneNumber = user.id.split(':')[0].replace('@s.whatsapp.net', '');
        session.pushName = user.name || null;
      }
      console.log(`[CONNECTED] ✅ ${instanceName} - ${session.phoneNumber}`);
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
      const hadQR = !!session.qrCode || !!session.qrGeneratedAt;
      const socketAge = Date.now() - (session.socketCreatedAt || session.createdAt);
      
      console.log(`[DISCONNECTED] ${instanceName} - Code: ${statusCode}, wasConnected: ${session.wasConnected}, hadQR: ${hadQR}, qrRetryCount: ${session.qrRetryCount}, socketAge: ${socketAge}ms`);
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: { connection: 'close', isConnected: false, statusCode }
      });
      
      // Lógica de reconexão melhorada v2.4.0
      if (statusCode === DisconnectReason?.loggedOut) {
        // Logout explícito - remover sessão
        console.log(`[LOGOUT] ${instanceName} fez logout, removendo sessão`);
        session.status = 'logged_out';
        sessions.delete(sessionId);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (e) {}
      } else if (session.wasConnected && session.retryCount < 5) {
        // Já tinha conectado antes - reconectar normalmente
        session.retryCount++;
        session.status = 'reconnecting';
        console.log(`[RECONNECT] Reconectando ${instanceName} em 3s... (tentativa ${session.retryCount}/5)`);
        setTimeout(async () => {
          try {
            await createSocketForSession(session);
          } catch (err) {
            console.error(`[RECONNECT] Erro:`, err.message);
          }
        }, 3000);
      } else if (!session.wasConnected && !hadQR && session.qrRetryCount < MAX_QR_RETRIES) {
        // v2.4.0: Nunca conectou E não gerou QR - TENTAR NOVAMENTE com delay maior
        session.qrRetryCount++;
        session.status = 'retrying';
        console.log(`[QR-RETRY] ${instanceName} desconectou sem QR, tentativa ${session.qrRetryCount}/${MAX_QR_RETRIES}`);
        
        // Criar socket de forma assíncrona (não bloquear)
        setImmediate(async () => {
          try {
            await createSocketForSession(session);
          } catch (err) {
            console.error(`[QR-RETRY] Erro:`, err.message);
            session.status = 'failed';
          }
        });
      } else if (!session.wasConnected && hadQR) {
        // Tinha QR mas não escaneou - manter sessão esperando
        session.status = 'waiting_scan';
        console.log(`[WAITING] ${instanceName} tem QR, aguardando escaneamento`);
      } else {
        // Esgotou tentativas
        console.log(`[FAILED] ${instanceName} esgotou tentativas de gerar QR (${session.qrRetryCount} tentativas)`);
        session.status = 'failed';
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

// ============ CRIAR SESSÃO WHATSAPP ============
async function createSession(sessionId, instanceName, webhookSecret) {
  if (!baileysLoaded) {
    throw new Error('Baileys ainda não carregado, aguarde alguns segundos');
  }
  
  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId);
    // Se já existe mas não tem QR e não está conectado, recriar socket
    if (!existing.qrCode && !existing.isConnected && existing.status !== 'retrying') {
      console.log(`[SESSION] ${sessionId} existe sem QR, recriando socket...`);
      existing.qrRetryCount = 0; // Reset counter
      return await createSocketForSession(existing);
    }
    console.log(`[SESSION] ${sessionId} já existe (status: ${existing.status})`);
    return existing;
  }

  console.log(`[SESSION] Criando nova sessão ${instanceName}`);

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
    qrRetryCount: 0,
    createdAt: Date.now(),
    socketCreatedAt: null,
    phoneNumber: null,
    pushName: null,
    status: 'connecting'
  };

  sessions.set(sessionId, session);
  
  await createSocketForSession(session);

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
    res.json({ 
      success: true, 
      version: VERSION, 
      sessionId: session.sessionId, 
      instanceName: session.instanceName, 
      isConnected: session.isConnected, 
      qrRetryCount: session.qrRetryCount,
      status: session.status
    });
  } catch (error) {
    console.error('[ERROR] Criar instância:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter QR Code
app.get('/api/instance/:sessionId/qr', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  res.json({ 
    qrCode: session.qrCode, 
    isConnected: session.isConnected, 
    phoneNumber: session.phoneNumber, 
    pushName: session.pushName,
    qrRetryCount: session.qrRetryCount,
    status: session.status
  });
});

// Obter status
app.get('/api/instance/:sessionId/status', (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada', status: 'not_found' });
  res.json({
    status: session.status,
    isConnected: session.isConnected,
    phoneNumber: session.phoneNumber,
    pushName: session.pushName,
    wasConnected: session.wasConnected,
    retryCount: session.retryCount,
    qrRetryCount: session.qrRetryCount,
    sessionAge: Date.now() - session.createdAt,
    hasQR: !!session.qrCode
  });
});

// Forçar regeneração de QR (v2.4.0 - mais robusto)
app.post('/api/instance/:sessionId/regenerate-qr', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  
  console.log(`[REGENERATE] Forçando regeneração de QR para ${session.instanceName}`);
  
  // Fechar socket existente se houver
  if (session.socket) {
    try {
      session.socket.end();
    } catch (e) {}
  }
  
  // Reset completo
  session.socket = null;
  session.qrCode = null;
  session.qrGeneratedAt = null;
  session.qrRetryCount = 0;
  session.retryCount = 0;
  session.status = 'connecting';
  session.wasConnected = false;
  
  // Limpar pasta de auth
  const sessionPath = path.join(SESSIONS_DIR, session.sessionId);
  try {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log(`[REGENERATE] Auth limpa para ${session.instanceName}`);
  } catch (e) {}
  
  // Aguardar um pouco antes de recriar
  await sleep(2000);
  
  try {
    await createSocketForSession(session);
    res.json({ success: true, message: 'Regenerando QR Code...', status: session.status });
  } catch (error) {
    console.error('[REGENERATE] Erro:', error);
    res.status(500).json({ error: error.message });
  }
});

// Listar sessões
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

// Deletar sessão
app.delete('/api/instance/:sessionId', async (req, res) => {
  const session = sessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Sessão não encontrada' });
  try {
    if (session.socket) {
      try {
        await session.socket.logout();
      } catch (e) {
        try {
          session.socket.end();
        } catch (e2) {}
      }
    }
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
    Browsers = baileys.Browsers || baileys.default?.Browsers;
    delay = baileys.delay || baileys.default?.delay;
    
    if (!useMultiFileAuthState || !makeCacheableSignalKeyStore || !fetchLatestBaileysVersion) {
      throw new Error('Funções auxiliares do Baileys não encontradas');
    }
    
    baileysLoaded = true;
    console.log('[BAILEYS] @whiskeysockets/baileys carregado ✓');
    console.log('[BAILEYS] makeWASocket:', typeof makeWASocket);
    console.log('[BAILEYS] Browsers:', typeof Browsers);
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

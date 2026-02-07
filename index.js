import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM __dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('='.repeat(60));
console.log('[INIT] 🚀 Baileys Server v2.9.5 iniciando...');
console.log('[INIT] 📦 Baileys 7.0.0-rc.9 (ESM)');
console.log('[INIT] 🔧 Sincronização de histórico completa');
console.log('[INIT] Node version:', process.version);
console.log('='.repeat(60));

const VERSION = "v2.9.5";
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

// ============ CRIAR SOCKET (v2.9.2 - Fix QR rápido) ============
async function createSocketForSession(session) {
  const { sessionId, instanceName } = session;
  const sessionPath = path.join(SESSIONS_DIR, sessionId);
  
  // ===== CHECK QR LOCK =====
  // Se QR foi gerado recentemente, NÃO reconectar
  if (session.qrGeneratedAt) {
    const timeSinceQR = Date.now() - session.qrGeneratedAt;
    if (timeSinceQR < QR_LOCK_TIME_MS) {
      const remaining = Math.ceil((QR_LOCK_TIME_MS - timeSinceQR) / 1000);
      console.log(`[QR LOCK] ⏳ QR gerado há ${Math.ceil(timeSinceQR/1000)}s, aguarde mais ${remaining}s`);
      console.log('[QR LOCK] Não reconectando para dar tempo de escanear');
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
  
  // Aguardar antes de criar socket
  await sleep(1000);
  
  // ========== CRIAR SOCKET - v2.9.4 Config ==========
  console.log('[SOCKET] Criando socket com config v2.9.4...');
  
  const logger = pino({ level: 'silent' });
  
  // CONFIGURAÇÃO v2.9.4 - Com sincronização de histórico
  const sock = makeWASocket({
    auth: state,
    browser: Browsers.macOS("Desktop"),
    logger: logger,
    // Habilitar sincronização de histórico
    syncFullHistory: true,           // IMPORTANTE: Sincronizar histórico completo
    markOnlineOnConnect: true,       // Marcar online para receber histórico
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
  
  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);
  console.log('[SOCKET] ✓ creds.update registrado');
  
  // CONNECTION UPDATE - Principal handler
  sock.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect } = update;
    
    console.log('[CONNECTION] Update:', JSON.stringify({
      hasQr: !!qr,
      connection: connection || null,
      qrLocked: session.qrGeneratedAt ? (Date.now() - session.qrGeneratedAt < QR_LOCK_TIME_MS) : false
    }));
    
    // ===== QR CODE =====
    if (qr) {
      console.log('[QR] 🎉 QR Code recebido!');
      try {
        session.qrCode = await QRCode.toDataURL(qr);
        session.qrGeneratedAt = Date.now();
        session.status = 'waiting_qr';
        console.log('[QR] ✅ QR Code convertido para DataURL');
        console.log('[QR] 🔒 QR Lock ativo por', QR_LOCK_TIME_MS / 1000, 's');
        
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
      session.qrGeneratedAt = null;  // Limpar lock
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
      const errorMessage = lastDisconnect?.error?.message || '';
      
      console.log('');
      console.log('[DISCONNECTED] ========================================');
      console.log(`[DISCONNECTED] Instância: ${instanceName}`);
      console.log(`[DISCONNECTED] Código: ${statusCode}`);
      console.log(`[DISCONNECTED] Erro: ${errorMessage}`);
      console.log('[DISCONNECTED] ========================================');
      
      await sendWebhook({
        event: 'connection.update',
        sessionId,
        instanceName,
        data: { connection: 'close', isConnected: false, statusCode }
      });
      
      // ===== 1. CHECK LOGOUT (401) - PRIORIDADE MÁXIMA =====
      if (statusCode === DisconnectReason?.loggedOut) {
        console.log('[LOGOUT] Usuário fez logout, removendo sessão');
        session.status = 'logged_out';
        sessions.delete(sessionId);
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
        } catch (e) {}
        return;
      }
      
      // ===== 2. CHECK 515 - PRIORIDADE SOBRE QR LOCK! =====
      // O erro 515 (restartRequired) é ESPERADO após escanear o QR
      // WhatsApp pede reconexão após pareamento bem-sucedido
      // DEVE vir ANTES do QR Lock check para não ser bloqueado!
      if (statusCode === 515 || statusCode === DisconnectReason?.restartRequired) {
        console.log('');
        console.log('[515] ═══════════════════════════════════════════════════');
        console.log('[515] ⚡ PAREAMENTO DETECTADO - Reconexão IMEDIATA');
        console.log('[515] Isso é NORMAL! WhatsApp pede restart após QR scan');
        console.log('[515] Credenciais JÁ FORAM SALVAS pelo pareamento');
        console.log('[515] ═══════════════════════════════════════════════════');
        console.log('');
        
        // IMPORTANTE: Limpar QR Lock pois pareamento foi bem-sucedido
        session.qrGeneratedAt = null;
        session.qrCode = null;
        session.status = 'reconnecting_after_pair';
        
        // NÃO incrementar retry - isso não é um erro real
        // NÃO limpar auth - credenciais já foram salvas
        
        // Fechar socket atual
        if (session.socket) {
          try { session.socket.end(); } catch (e) {}
          session.socket = null;
        }
        
        // Reconectar IMEDIATAMENTE (1s para dar tempo de limpar socket)
        setTimeout(async () => {
          try {
            console.log('[515] 🔄 Iniciando reconexão com credenciais salvas...');
            await createSocketForSession(session);
          } catch (err) {
            console.error('[515] ❌ Erro na reconexão:', err.message);
            session.status = 'failed';
          }
        }, 1000);
        
        return;
      }
      
      // ===== 3. CHECK QR LOCK - Apenas para outros erros =====
      // Este check impede reconexões enquanto usuário escaneia
      // MAS não deve bloquear o 515 (já tratado acima)
      if (session.qrGeneratedAt) {
        const timeSinceQR = Date.now() - session.qrGeneratedAt;
        if (timeSinceQR < QR_LOCK_TIME_MS) {
          const remaining = Math.ceil((QR_LOCK_TIME_MS - timeSinceQR) / 1000);
          console.log(`[QR LOCK] ⏳ QR ativo, NÃO reconectando (aguarde ${remaining}s)`);
          console.log('[QR LOCK] Usuário pode estar escaneando o QR');
          return;
        }
      }
      
      // ===== 4. ERROS 405/408 - Protocolo =====
      if (statusCode === 405 || statusCode === 408) {
        console.log(`[${statusCode}] Erro de protocolo`);
        session.retryCount++;
        if (session.retryCount < MAX_RETRIES) {
          session.qrCode = null;
          session.qrGeneratedAt = null;
          session.status = 'reconnecting';
          console.log(`[${statusCode}] Reconectando em ${RETRY_DELAY_MS/1000}s (tentativa ${session.retryCount})`);
          setTimeout(async () => {
            try {
              await createSocketForSession(session);
            } catch (err) {
              console.error(`[${statusCode}] Erro ao reconectar:`, err.message);
              session.status = 'failed';
            }
          }, RETRY_DELAY_MS);
        } else {
          console.log(`[${statusCode}] Esgotou tentativas`);
          session.status = 'failed';
        }
        return;
      }
      
      // ===== 5. OUTROS ERROS =====
      if (session.retryCount < MAX_RETRIES) {
        session.retryCount++;
        session.status = 'reconnecting';
        console.log(`[RETRY] Tentativa ${session.retryCount}/${MAX_RETRIES} em ${RETRY_DELAY_MS/1000}s...`);
        setTimeout(async () => {
          try {
            await createSocketForSession(session);
          } catch (err) {
            console.error('[RETRY] Erro:', err.message);
            session.status = 'failed';
          }
        }, RETRY_DELAY_MS);
      } else {
        console.log('[FAILED] Esgotou tentativas');
        session.status = 'failed';
      }
    }
  });
  console.log('[SOCKET] ✓ connection.update registrado');
  
  // MENSAGENS (novas e histórico)
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // Processar tanto 'notify' (novas) quanto 'append' (histórico)
    console.log(`[MESSAGES] Tipo: ${type}, Quantidade: ${messages.length}`);
    
    for (const msg of messages) {
      if (msg.key.remoteJid === 'status@broadcast') continue;
      
      // Ignorar mensagens de protocolo (sync notifications)
      if (msg.message?.protocolMessage) continue;
      
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
            pushName: msg.pushName
          }]
        }
      });
    }
  });
  console.log('[SOCKET] ✓ messages.upsert registrado');
  
  // CHATS SINCRONIZADOS
  sock.ev.on('chats.upsert', async (chats) => {
    console.log(`[CHATS] 📥 ${chats.length} chats sincronizados!`);
    
    await sendWebhook({
      event: 'chats.upsert',
      sessionId,
      instanceName,
      data: { chats }
    });
  });
  console.log('[SOCKET] ✓ chats.upsert registrado');
  
  // CHATS SET (histórico completo)
  sock.ev.on('chats.set', async ({ chats, isLatest }) => {
    console.log(`[CHATS SET] 📥 ${chats.length} chats (isLatest: ${isLatest})`);
    
    await sendWebhook({
      event: 'chats.set',
      sessionId,
      instanceName,
      data: { chats, isLatest }
    });
  });
  console.log('[SOCKET] ✓ chats.set registrado');
  
  // CONTATOS SINCRONIZADOS
  sock.ev.on('contacts.upsert', async (contacts) => {
    console.log(`[CONTACTS] 📥 ${contacts.length} contatos sincronizados!`);
    
    await sendWebhook({
      event: 'contacts.upsert',
      sessionId,
      instanceName,
      data: { contacts }
    });
  });
  console.log('[SOCKET] ✓ contacts.upsert registrado');
  
  // CONTATOS SET (lista completa)
  sock.ev.on('contacts.set', async ({ contacts }) => {
    console.log(`[CONTACTS SET] 📥 ${contacts.length} contatos`);
    
    await sendWebhook({
      event: 'contacts.set',
      sessionId,
      instanceName,
      data: { contacts }
    });
  });
  console.log('[SOCKET] ✓ contacts.set registrado');
  
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

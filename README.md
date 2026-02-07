# 🚀 Baileys Server v2.9.2 - Fix QR Rápido

## ✅ Correções v2.9.2

Esta versão corrige o problema do **QR Code regenerando muito rápido**.

### Mudanças v2.9.2:
- ✅ **QR Lock** - Impede regeneração enquanto usuário escaneia (60s)
- ✅ **Retry delay aumentado** - 15s entre tentativas
- ✅ **Sem printQRInTerminal** - Remove warning deprecated
- ✅ **retryRequestDelayMs** - Delay de 2s entre requests
- ✅ **connectTimeoutMs** - Timeout de 60s para conexão

### Versões Anteriores:
- ✅ **Node.js 20** (obrigatório para Baileys 7.x)
- ✅ **Baileys 7.0.0-rc.9** (versão mais recente)
- ✅ **Browsers.macOS("Desktop")** - browser string oficial

## Deploy no Railway

### 1. Suba para o GitHub
- Substitua **TODOS** os arquivos

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
Aguarde deploy completo (~3-4 minutos).

## Verificação de Logs

Nos logs do Railway, você deve ver:

```
[INIT] Baileys Server v2.9.2 iniciando...
[QR] 🎉 QR Code recebido!
[QR] 🔒 QR Lock ativo por 60s
```

Se o QR regenerar antes de 60s, há outro problema.

# 🚀 Baileys Server v2.9.3 - Fix Erro 515 Após QR Scan

## ✅ Correções v2.9.3

Esta versão corrige o erro **"Não foi possível conectar o dispositivo"** após escanear o QR.

### Mudanças v2.9.3:
- ✅ **Reconexão IMEDIATA no 515** - 1s ao invés de 15s (CRÍTICO!)
- ✅ **Preserva credenciais no 515** - Não limpa auth após pareamento
- ✅ **Status específico** - `reconnecting_after_pair` para debug

### Por que funciona:
O erro 515 é **ESPERADO** após escanear o QR - é o WhatsApp pedindo reconexão.
A v2.9.2 esperava 15s e limpava auth, causando timeout no celular.
A v2.9.3 reconecta em 1s, permitindo conexão bem-sucedida.

### Versões Anteriores:
- ✅ **QR Lock 60s** - Impede regeneração enquanto escaneia
- ✅ **Node.js 20** (obrigatório para Baileys 7.x)
- ✅ **Baileys 7.0.0-rc.9** (versão mais recente)

## Deploy no Railway

### 1. Suba para o GitHub
- Substitua **TODOS** os arquivos (especialmente index.js!)

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
Aguarde deploy completo (~3-4 minutos).

## Verificação de Logs

Após escanear o QR, você verá:

```
[QR] 🎉 QR Code recebido!
... (usuário escaneia)
[515] ⚡ Stream Error - Reconexão IMEDIATA
[515] Isso é NORMAL após escanear o QR
[515] Iniciando reconexão...
[CONNECTED] ✅ WhatsApp conectado!
```

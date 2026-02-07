# 🚀 Baileys Server v2.9.6 - Sync Completo com Fotos

## ✅ Correções v2.9.6

Esta versão adiciona **sincronização de fotos de perfil** e **conversas recentes**.

### Mudanças v2.9.6:
- ✅ **Busca foto de perfil** - profilePictureUrl para cada contato
- ✅ **Conversas com fotos** - Envia foto junto com chat
- ✅ **Histórico de mensagens** - messages.set + messaging-history.set
- ✅ **Nome do contato** - pushName/notify corretos
- ✅ **Endpoint /sync-profile-pics** - Força busca de fotos

### Histórico de versões:
- v2.9.5: Sync de histórico completo
- v2.9.4: Fix QR Lock bloqueando 515
- v2.9.3: Reconexão imediata no 515

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

Após conectar, você verá:

```
[CONNECTED] ✅ WhatsApp conectado!
[CHATS] 📥 50 chats sincronizados!
[PROFILE PIC] 📸 Buscando fotos de perfil...
```

# 🚀 Baileys Server v2.9.5 - Sincronização de Histórico

## ✅ Correções v2.9.5

Esta versão adiciona **sincronização completa de histórico** de conversas e contatos.

### Mudanças v2.9.5:
- ✅ **Sync de histórico completo** - syncFullHistory: true
- ✅ **Handler chats.upsert** - Sincroniza lista de chats
- ✅ **Handler chats.set** - Recebe histórico completo  
- ✅ **Handler contacts.upsert** - Sincroniza contatos
- ✅ **Suporte ao formato @lid** - Novo formato do WhatsApp

### Histórico de versões:
- v2.9.4: Fix QR Lock bloqueando 515
- v2.9.3: Reconexão imediata no 515
- v2.9.2: QR Lock 60s

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
[CONTACTS] 📥 100 contatos sincronizados!
```

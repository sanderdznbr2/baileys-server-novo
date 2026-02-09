# 🚀 Baileys Server v4.6.0 - Proactive Metadata Sync

## ✨ Novidades v4.6.0

- ✅ **SYNC PROATIVO de fotos** - busca automaticamente após conexão
- ✅ **Webhook contact.metadata** - envia dados de cada contato/grupo
- ✅ **Cache global de nomes** - por JID para todas as sessões
- ✅ **Download de STICKERS** - salva no storage Supabase
- ✅ **Histórico de 6 HORAS** - mensagens antigas
- ✅ **syncFullHistory habilitado** - histórico completo

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key`

**IMPORTANTE**: Delete a pasta `sessions/` para uma conexão limpa!

## Endpoints

### Sync Paginado de Contatos
```bash
POST /api/sync/contacts
{ "instanceName": "sua-instancia", "page": 1, "pageSize": 50 }
```

### Sync Paginado de Chats
```bash
POST /api/sync/chats
{ "instanceName": "sua-instancia", "page": 1, "pageSize": 30 }
```

### Status com Contagem
```bash
GET /api/instance/:instanceName/status
```

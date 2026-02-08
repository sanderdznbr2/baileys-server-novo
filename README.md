# 🚀 Baileys Server v4.3.0 - Sincronização Completa

## ✨ Novidades v4.3.0

- ✅ **Sincronização COMPLETA de contatos** - não apenas recentes
- ✅ **Paginação para grandes listas** - evita timeout
- ✅ **syncFullHistory habilitado** - histórico completo
- ✅ **Batching de webhooks** - envia em lotes de 50
- ✅ **Sync bidirecional de lidas** - via message-receipt.update
- ✅ **Cache em memória** - contatos e chats por sessão
- ✅ **Endpoints de sync incremental** - /api/sync/contacts e /api/sync/chats

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key`

**IMPORTANTE**: Delete a pasta `sessions/` para uma conexão limpa com sync completo!

## Novos Endpoints

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

Resposta inclui:
- contactsCount: número total de contatos em cache
- chatsCount: número total de chats em cache

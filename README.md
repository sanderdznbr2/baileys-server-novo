# 🚀 Baileys Server v4.4.0 - Histórico Estendido

## ✨ Novidades v4.4.0

- ✅ **Histórico de 6 HORAS** - sincroniza mensagens das últimas 6 horas (era 1h)
- ✅ **Sincronização COMPLETA de contatos** - não apenas recentes
- ✅ **Paginação para grandes listas** - evita timeout
- ✅ **syncFullHistory habilitado** - histórico completo
- ✅ **Batching otimizado** - envia em lotes de 20 mensagens
- ✅ **Cache em memória** - contatos e chats por sessão

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key`

**IMPORTANTE**: Delete a pasta `sessions/` para uma conexão limpa com sync de 6h!

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

Resposta inclui:
- contactsCount: número total de contatos em cache
- chatsCount: número total de chats em cache
- historyHours: 6 (horas de histórico)

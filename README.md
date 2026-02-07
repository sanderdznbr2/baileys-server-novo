# 🚀 Baileys Server v3.7.0 - Estável e Completo

## ✨ Novidades v3.7.0

### 🔄 Estabilidade
- **Heartbeat automático** - Ping a cada 25s mantém conexão
- **Reconexão inteligente** - Backoff exponencial
- **Timeout configurável** - 90s para conexão inicial

### 👥 Contatos
- **Sincronização completa** - Todos os contatos ao conectar
- **Fotos de perfil** - Busca automática com cache

### 📸 Mídia
- **Upload automático** - Supabase Storage
- **Retry inteligente** - 5 tentativas
- **Todos os tipos** - Imagens, vídeos, áudios, documentos

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key`

**NÃO** defina PORT - Railway define automaticamente!

## Comportamento

### ✅ O que SERÁ sincronizado:
- Todos os contatos ao conectar
- Mensagens novas após conexão
- Todas as mídias (imagens, áudios, vídeos)

### ❌ O que NÃO será sincronizado:
- Histórico de conversas antigas

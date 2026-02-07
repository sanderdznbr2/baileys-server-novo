# 🚀 Baileys Server v3.4.0 - Metadata de Grupos

## ✅ Novidades v3.4.0

### Principais Mudanças:
- ✅ **METADATA DE GRUPOS NO HISTORY SYNC** - Busca nomes dos grupos automaticamente
- ✅ **SYNC COMPLETO DE HISTÓRICO** - Sincroniza todas as conversas ao conectar
- ✅ **Cache de Metadados** - Performance otimizada
- ✅ **Nome do Grupo Correto** - Busca metadados do grupo para exibir nome real
- ✅ **Identificação de Remetentes** - Mostra quem enviou cada mensagem nos grupos
- ✅ **Suporte a Mídias** - Imagens, vídeos, áudios, documentos e stickers

## Deploy no Railway

### 1. Suba para o GitHub
- Substitua **TODOS** os arquivos (especialmente index.js!)
- Delete a pasta `sessions/` se existir

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key` (pegar no Dashboard Supabase > Settings > API)

**NÃO** defina PORT - Railway define automaticamente!

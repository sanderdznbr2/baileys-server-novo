# 🚀 Baileys Server v3.6.0 - SEM Histórico

## ✅ Novidades v3.6.0

### 🚫 HISTÓRICO DESABILITADO
- **Sem conversas antigas** - Apenas mensagens novas após conexão
- **Sem grupos antigos** - Grupos aparecem quando há nova mensagem
- **Performance otimizada** - Conexão muito mais rápida

### Principais Features:
- ✅ **NOMES DE GRUPOS CORRETOS** - Busca groupMetadata automaticamente
- ✅ **REMETENTES EM GRUPOS** - sender_phone e sender_name corretos
- ✅ **FOTOS DE PERFIL** - Para contatos e grupos
- ✅ **MÍDIAS** - Imagens, vídeos, áudios, documentos

## Deploy no Railway

### 1. Suba para o GitHub
- Substitua **TODOS** os arquivos
- **IMPORTANTE:** Delete a pasta `sessions/` para uma nova conexão limpa

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key` (pegar no Dashboard Supabase > Settings > API)

**NÃO** defina PORT - Railway define automaticamente!

## Comportamento

### ✅ O que SERÁ processado:
- Mensagens novas recebidas após conexão
- Mensagens enviadas por você
- Novos grupos que você é adicionado
- Contatos que enviam mensagem pela primeira vez

### ❌ O que NÃO será processado:
- Histórico de conversas antigas
- Mensagens anteriores à conexão
- Grupos antigos (só aparecem quando houver nova mensagem)

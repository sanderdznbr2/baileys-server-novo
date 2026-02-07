# 🚀 Baileys Server v4.0.0 - Reidratação de 1 Hora

## ✨ Novidades v4.0.0

### 🔄 Reidratação de 1 Hora
- **Ao reconectar**: Busca mensagens da última 1 hora do banco
- **Reenvia ao webhook**: Mensagens aparecem instantaneamente
- **Preservação**: Nunca sobrescreve nomes/fotos existentes

### 🔐 Preservação de Contatos
- **Nomes persistentes**: Contato salvo nunca perde o nome
- **Fotos de perfil**: Mantém foto mesmo após reconexão
- **Fallback**: Usa dados do banco quando WhatsApp não retorna

### 🔧 Estabilidade
- **Heartbeat 20s** - Conexão mais estável
- **Reconexão inteligente** - Backoff exponencial
- **Proteção anti-flood** - Limita downloads de mídia

### 📸 Mídia
- **Upload automático** - Supabase Storage
- **Retry inteligente** - 3 tentativas com delay
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
- Mensagens da última 1 hora (ao reconectar)
- Todos os contatos com nomes/fotos preservados
- Mensagens novas em tempo real
- Todas as mídias

### ❌ O que NÃO será perdido:
- Nomes de contatos salvos
- Fotos de perfil existentes
- Histórico no banco de dados

## Migração da v3.x

1. Baixe o novo servidor v4.0.0
2. No Railway: substitua arquivos
3. NÃO delete a pasta sessions/ (mantém login)
4. Reinicie o serviço

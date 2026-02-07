# 🚀 Baileys Server v4.1.0 - Metadados Completos

## ✨ Novidades v4.1.0

### 📸 Foto de Grupos
- Busca `profilePictureUrl()` para grupos (`@g.us`)
- Exibe foto de perfil do grupo no CRM

### 📝 Descrição do Grupo
- Busca `groupMetadata().desc`
- Mostra descrição/bio do grupo

### 👥 Lista de Participantes
- Busca `groupMetadata().participants`
- Retorna lista com roles: `{ jid, isAdmin, isSuperAdmin }`
- Permite identificar admins do grupo

### 💬 Status dos Contatos
- Busca `fetchStatus(jid)` para contatos individuais
- Mostra o status/bio de cada contato

### 🔄 Reidratação de 1 Hora
- Ao reconectar, busca mensagens da última 1h
- Sincroniza automaticamente com o webhook

### 🔐 Preservação de Dados
- Nomes e fotos nunca são sobrescritos por valores vazios
- Banco de dados é a fonte da verdade

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key`

**NÃO** defina PORT - Railway define automaticamente!

## Comportamento

### ✅ O que será buscado:
- Foto de perfil (contatos E grupos)
- Descrição do grupo
- Lista de participantes com roles
- Status/bio dos contatos
- Mensagens da última 1h (ao reconectar)

### ❌ O que NÃO será perdido:
- Nomes de contatos salvos
- Fotos de perfil existentes
- Histórico no banco de dados

## Migração da v4.0.0

1. Baixe o novo servidor v4.1.0
2. No Railway: substitua arquivos
3. NÃO delete a pasta sessions/ (mantém login)
4. Reinicie o serviço

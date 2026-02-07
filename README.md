# 🚀 Baileys Server v3.3.0 - Sync Completo

## ✅ Novidades v3.3.0

### Principais Mudanças:
- ✅ **SYNC COMPLETO DE HISTÓRICO** - Sincroniza todas as conversas ao conectar
- ✅ **Handler messaging-history.set** - Recebe mensagens históricas
- ✅ **Handler chats.set** - Recebe lista de chats inicial
- ✅ **Processamento em batches** - Evita timeout com muitos dados
- ✅ **Nome do Grupo Correto** - Busca metadados do grupo para exibir nome real
- ✅ **Identificação de Remetentes** - Mostra quem enviou cada mensagem nos grupos
- ✅ **Suporte a Mídias** - Imagens, vídeos, áudios, documentos e stickers
- ✅ **Upload para Supabase Storage** - Mídias são salvas no bucket whatsapp-media

### Tipos de Mídia Suportados:
| Tipo | Extensão | Descrição |
|------|----------|-----------|
| image | jpg | Fotos e imagens |
| video | mp4 | Vídeos |
| ptt | ogg | Mensagens de voz |
| audio | mp3 | Arquivos de áudio |
| document | pdf, doc, etc | Documentos |
| sticker | webp | Figurinhas |

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

### 3. Pronto!
Aguarde deploy completo (~3-4 minutos).

## Verificação de Logs

Após conectar, você verá:

```
============================================
🚀 Baileys Server v3.3.0 running on port XXXX
============================================
📡 Webhook URL: https://...
📸 Media Support: ✅ Enabled
📜 History Sync: ✅ Enabled
============================================
```

E ao conectar um WhatsApp:
```
📋 [CHATS.SET] Syncing X chats...
📜 [HISTORY SYNC] X chats, Y messages
```

## Endpoints da API

### Health Check
`GET /api/health`

### Criar Instância
`POST /api/instance/create`
```json
{
  "sessionId": "uuid",
  "instanceName": "minha-instancia",
  "webhookSecret": "opcional"
}
```

### Obter QR Code
`GET /api/instance/:sessionId/qr`

### Status da Conexão
`GET /api/instance/:sessionId/status`

### Enviar Mensagem de Texto
`POST /api/message/send-text`
```json
{
  "sessionId": "uuid",
  "phone": "5511999999999",
  "message": "Olá!"
}
```

### Enviar Mídia
`POST /api/message/send-media`
```json
{
  "sessionId": "uuid",
  "phone": "5511999999999",
  "mediaUrl": "https://...",
  "mediaType": "image|video|audio|ptt|document",
  "caption": "Legenda opcional",
  "fileName": "documento.pdf"
}
```

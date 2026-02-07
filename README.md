# 🚀 Baileys Server v3.1.0 - Suporte a Mídias e Grupos

## ✅ Novidades v3.1.0

### Mudanças v3.1.0:
- ✅ **Suporte Completo a Grupos** - Identifica quem enviou cada mensagem
- ✅ **Suporte a Mídias** - Imagens, vídeos, áudios, documentos e stickers
- ✅ **Upload para Supabase Storage** - Mídias são salvas no bucket whatsapp-media
- ✅ **Retry em Downloads** - 3 tentativas para download de mídias
- ✅ **Melhor Identificação de Contatos** - Nome e telefone do remetente em grupos

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
🚀 Baileys Server v3.1.0 running on port XXXX
============================================
📡 Webhook URL: https://...
📸 Media Support: ✅ Enabled
============================================
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

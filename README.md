# 🚀 Baileys Server v3.0.0 - Suporte Completo a Mídias

## ✅ Novidades v3.0.0

Esta versão adiciona suporte completo a **mídias** (imagens, áudios, vídeos, documentos).

### Mudanças v3.0.0:
- ✅ **Suporte a Mídias** - Imagens, vídeos, áudios, documentos e stickers
- ✅ **Upload para Supabase Storage** - Mídias são salvas no bucket whatsapp-media
- ✅ **CommonJS** - Melhor compatibilidade com Railway
- ✅ **Baileys 6.7.9** - Versão estável com suporte a mídias

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
🚀 Baileys Server v3.0.0 running on port XXXX
📡 Webhook URL: https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook
📸 Media Support: Enabled
```

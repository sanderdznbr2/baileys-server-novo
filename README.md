# 🚀 Baileys Server v4.8.0 - Audio Fix & Mimetype Detection

## ✨ Novidades v4.8.0

- 🎙️ **Correção de áudio IA** - detecta mimetype MP3 vs OGG automaticamente
- 🔊 **send-voice aceita mimetype** - parâmetro opcional para formato do áudio
- ✅ Tudo do v4.7.0 mantido (validação de número, 9º dígito, etc.)

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   \`SUPABASE_WEBHOOK_URL\` = \`https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook\`
   \`SUPABASE_URL\` = \`https://jwddiyuezqrpuakazvgg.supabase.co\`
   \`SUPABASE_SERVICE_ROLE_KEY\` = \`sua_service_role_key\`

**IMPORTANTE**: Delete a pasta \`sessions/\` para uma conexão limpa!

## Correção v4.8.0

### send-voice com mimetype
\`\`\`bash
POST /api/message/send-voice
{
  "instanceName": "sua-instancia",
  "jid": "5541999999999@s.whatsapp.net",
  "audioUrl": "https://..../audio.mp3",
  "mimetype": "audio/mpeg"  // opcional - auto-detecta pela extensão
}
\`\`\`

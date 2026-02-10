# 🚀 Baileys Server v4.7.0 - Number Validation & JID Resolution

## ✨ Novidades v4.7.0

- 🔍 **Validação de número** - endpoint /api/number/check via onWhatsApp()
- 🇧🇷 **Correção 9o dígito brasileiro** - resolve automaticamente
- ✅ Tudo do v4.6.0 mantido (sync proativo, stickers, cache, etc.)

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   \`SUPABASE_WEBHOOK_URL\` = \`https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook\`
   \`SUPABASE_URL\` = \`https://jwddiyuezqrpuakazvgg.supabase.co\`
   \`SUPABASE_SERVICE_ROLE_KEY\` = \`sua_service_role_key\`

**IMPORTANTE**: Delete a pasta \`sessions/\` para uma conexão limpa!

## Novo Endpoint v4.7.0

### Verificar Número
\`\`\`bash
POST /api/number/check
{ "instanceName": "sua-instancia", "phone": "5541996875461" }
# Resposta: { "exists": true, "jid": "554196875461@s.whatsapp.net" }
\`\`\`

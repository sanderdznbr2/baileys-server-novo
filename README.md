# 🚀 Baileys Server v4.2.0 - Estável

## ✨ Correções v4.2.0

- ✅ **Removida dependência @supabase/supabase-js** - usa fetch nativo
- ✅ QR Code gerado corretamente
- ✅ Metadados de grupos (foto, descrição, participantes)
- ✅ Status/bio de contatos individuais
- ✅ Sincronização de contatos via contacts.set
- ✅ Reconexão automática com backoff exponencial

## Deploy no Railway

1. New Project → Deploy from GitHub
2. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`
   `SUPABASE_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co`
   `SUPABASE_SERVICE_ROLE_KEY` = `sua_service_role_key`

**NÃO** defina PORT - Railway define automaticamente!

## Dependências

- @whiskeysockets/baileys: ^6.7.17
- express: ^4.21.2
- cors: ^2.8.5
- pino: ^9.6.0
- qrcode: ^1.5.4

**NÃO** inclui @supabase/supabase-js - todas as chamadas são via fetch.

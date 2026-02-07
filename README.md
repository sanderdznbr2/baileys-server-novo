# 🚀 Baileys Server v2.8.0 - BROWSER STRING FIXO

## ✅ Correções v2.8.0

O problema anterior era que `Browsers.appropriate('Desktop')` retornava 
`['Ubuntu', 'Desktop', '6.12.12+bpo-cloud-amd64']` que o WhatsApp não reconhece.

### Mudanças:
- ✅ Browser string FIXO: ["Chrome (Linux)", "Chrome", "130.0.6723.70"]
- ✅ Baileys 6.7.9 (versão estável)
- ✅ Sem dependência de Browsers.appropriate()
- ✅ Delay de 2s antes de criar socket

## Deploy no Railway

### 1. Suba para o GitHub
- Crie um repositório no GitHub
- Faça upload destes arquivos

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
O servidor vai iniciar automaticamente.

## Verificação de Logs

Nos logs do Railway, você deve ver:

```
[BAILEYS] ✓ Módulo importado
[SOCKET] Browser: ["Chrome (Linux)", "Chrome", "130.0.6723.70"]
[QR] 🎉 QR Code recebido!
[CONNECTED] ✅ WhatsApp conectado!
```

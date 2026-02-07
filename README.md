# 🚀 Baileys Server v2.9.0 - ESM + Baileys 7.x

## ✅ Correções v2.9.0

Esta versão resolve o **Erro 405** usando Baileys 7.x com configuração oficial.

### Mudanças Principais:
- ✅ **Baileys 7.0.0-rc.9** (versão mais recente)
- ✅ **ESM** (type: module) - obrigatório para Baileys 7.x
- ✅ **Browsers.macOS("Desktop")** - browser string oficial
- ✅ **Auth simplificado** - sem makeCacheableSignalKeyStore
- ✅ **Sem versão manual** - deixa o Baileys negociar automaticamente

## Deploy no Railway

### 1. Suba para o GitHub
- Crie um repositório no GitHub
- Faça upload de TODOS estes arquivos
- **IMPORTANTE**: O package.json deve ter "type": "module"

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
O servidor vai iniciar automaticamente (3-4 minutos na primeira vez).

## Verificação de Logs

Nos logs do Railway, você deve ver:

```
[INIT] Baileys Server v2.9.0 iniciando...
[INIT] Baileys 7.0.0-rc.9 (ESM)
[INIT] Browser: Browsers.macOS("Desktop")
[BAILEYS] ✅ Carregado com sucesso!
[SOCKET] Criando com Browsers.macOS("Desktop")...
[QR] ✅ QR Code recebido!
```

## Nota sobre Erro 405

O erro 405 é uma rejeição ativa do WhatsApp. Com v2.9.0:
- Usamos a versão mais recente do Baileys
- Usamos o browser string oficial
- Deixamos o protocolo ser negociado automaticamente

Se ainda persistir, pode ser bloqueio de IP/região pelo WhatsApp.

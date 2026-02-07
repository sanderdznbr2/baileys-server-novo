# 🚀 Baileys Server v2.6.0 - VERSÃO ESTÁVEL

## ⚠️ IMPORTANTE: Usa Baileys 6.5.0 (não 6.7.x)

A versão 6.7.x do Baileys tem bugs conhecidos que causam desconexão 
antes de gerar QR Code. Esta versão usa 6.5.0 que é estável.

## Issues conhecidos no 6.7.x:
- #2050: QR missing em 6.7.21
- #2040: Desconexão automática em 6.7.20
- #1914: Socket não gera QR

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
[BAILEYS] ✓ Versão 6.5.0 detectada
[SESSION] Criando socket...
[QR] ✅ QR Code gerado!
```

## Diferença para v2.5.0

| Item | v2.5.0 | v2.6.0 |
|------|--------|--------|
| Baileys | ^6.7.9 (bugada) | 6.5.0 (estável) |
| Configuração | 15+ opções | 4 opções |
| makeCacheableSignalKeyStore | Sim | Não |
| fetchLatestBaileysVersion | Sim | Não |

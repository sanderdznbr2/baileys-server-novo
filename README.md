# 🚀 Baileys Server v2.5.0 para WhatsApp CRM

## Novidades v2.5.0
- ✅ Listener direto para evento 'qr' (mais confiável)
- ✅ Logging detalhado por etapas (debug fácil)
- ✅ Error handling robusto no auth state
- ✅ Retry automático em desconexões rápidas
- ✅ Até 10 tentativas de gerar QR Code

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
[SOCKET] Etapa 1: Preparando diretório de auth...
[SOCKET] Etapa 2: Carregando auth state...
[SOCKET] Etapa 3: Buscando versão do Baileys...
[SOCKET] Etapa 4: Configurando socket...
[SOCKET] Etapa 5: Criando socket Baileys...
[SOCKET] Etapa 6: Registrando event listeners...
[QR-EVENT] ⚡⚡⚡ EVENTO QR RECEBIDO DIRETAMENTE! ⚡⚡⚡
```

Se parar antes da "Etapa 5", o problema é no auth state.
Se parar após "Etapa 5", o problema é na conexão com WhatsApp.

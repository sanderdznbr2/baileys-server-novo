# 🚀 Baileys Server v2.9.4 - Fix QR Lock Bloqueando 515

## ✅ Correções v2.9.4

Esta versão corrige o bug onde o **QR Lock bloqueava a reconexão após pareamento**.

### Mudanças v2.9.4:
- ✅ **515 tem PRIORIDADE sobre QR Lock** - Handler 515 vem ANTES do check QR Lock
- ✅ **Limpa QR Lock no 515** - Quando pareamento detectado, remove o lock
- ✅ **Reconexão em 1s** - Imediata após detectar pareamento

### Por que funciona:
O bug na v2.9.3: QR Lock check vinha ANTES do handler 515.
Como o QR foi gerado há menos de 60s quando escaneia, o código fazia return e NUNCA chegava ao handler 515.
Na v2.9.4: Handler 515 vem PRIMEIRO e limpa o QR Lock.

### Histórico:
- v2.9.2: QR Lock 60s (impede regeneração)
- v2.9.3: Reconexão 515 em 1s (mas bloqueada pelo QR Lock)
- **v2.9.4: 515 tem prioridade sobre QR Lock** ✅

## Deploy no Railway

### 1. Suba para o GitHub
- Substitua **TODOS** os arquivos (especialmente index.js!)

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
Aguarde deploy completo (~3-4 minutos).

## Verificação de Logs

Após escanear o QR, você verá:

```
[QR] 🎉 QR Code recebido!
[QR] 🔒 QR Lock ativo por 60s
... (usuário escaneia)
[DISCONNECTED] Código: 515
[515] ⚡ PAREAMENTO DETECTADO - Reconexão IMEDIATA
[515] Isso é NORMAL! WhatsApp pede restart após QR scan
[515] 🔄 Iniciando reconexão com credenciais salvas...
[CONNECTED] ✅ WhatsApp conectado!
```

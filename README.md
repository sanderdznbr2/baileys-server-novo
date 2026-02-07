# 🚀 Baileys Server v2.9.1 - ESM + Baileys 7.x + Node 20

## ✅ Correções v2.9.1

Esta versão resolve o **Erro 405** usando Baileys 7.x com configuração oficial.

### Mudanças Principais:
- ✅ **Node.js 20** (obrigatório para Baileys 7.x)
- ✅ **Baileys 7.0.0-rc.9** (versão mais recente)
- ✅ **ESM** (type: module) - obrigatório para Baileys 7.x
- ✅ **Browsers.macOS("Desktop")** - browser string oficial
- ✅ **nixpacks.toml** - força Railway a usar Node 20
- ✅ **.node-version** - especifica Node 20

## Deploy no Railway

### 1. Suba para o GitHub
- Crie um repositório no GitHub
- Faça upload de **TODOS** estes arquivos (incluindo .node-version e nixpacks.toml)

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
O Railway vai usar Node.js 20 automaticamente (3-4 minutos).

## Verificação de Logs

Nos logs do Railway, você deve ver:

```
[INIT] Baileys Server v2.9.1 iniciando...
[INIT] Baileys 7.0.0-rc.9 (ESM)
[INIT] Node version: v20.x.x  <-- IMPORTANTE!
[BAILEYS] ✅ Carregado com sucesso!
[QR] ✅ QR Code recebido!
```

## Arquivos Importantes

- **nixpacks.toml** - Configura Railway para usar Node 20
- **.node-version** - Especifica a versão do Node
- **package.json** - engines: ">=20"

Se o deploy falhar com erro de Node 18, verifique se o nixpacks.toml foi incluído.

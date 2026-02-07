# 🚀 Baileys Server para WhatsApp CRM

## Deploy no Railway (SUPER SIMPLES!)

### 1. Suba para o GitHub
- Crie um repositório no GitHub
- Faça upload destes arquivos

### 2. No Railway
1. New Project → Deploy from GitHub
2. Selecione seu repositório
3. Em **Variables**, adicione:
   `SUPABASE_WEBHOOK_URL` = `https://jwddiyuezqrpuakazvgg.supabase.co/functions/v1/whatsapp-webhook`

### 3. Pronto!
O servidor vai iniciar automaticamente. Teste:
`https://SEU-DOMINIO.railway.app/api/health`

## Estrutura
```
baileys-server/
├── index.js       ← Servidor completo (único arquivo!)
├── package.json
├── .gitignore
└── README.md
```

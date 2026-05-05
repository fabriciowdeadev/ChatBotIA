# ChatBotIA

Chatbot WhatsApp para o Klebinho Lanches, com IA Gemini, cálculo de frete via Google Maps e painel web.

## Stack

- **whatsapp-web.js** — integração WhatsApp
- **Gemini 2.0 Flash** — IA para atendimento
- **Google Maps Distance Matrix** — cálculo de frete
- **Socket.io + Express** — painel web em tempo real
- **Docker** — deploy na VPS via Dokploy

## Variáveis de ambiente

Copie `.env.example` para `.env` e preencha:

| Variável | Descrição |
|---|---|
| `GEMINI_API_KEY` | Chave da API Gemini |
| `MAPS_API_KEY` | Chave Google Maps |
| `DELIVERY_ORIGIN` | Endereço de origem para frete |
| `DELIVERY_PRICE_PER_KM` | Preço por km (padrão: 1) |
| `PANEL_PASSWORD` | Senha do painel web |
| `PORT` | Porta HTTP (padrão: 3000) |

## Deploy Dokploy (VPS)

1. Adicione o repositório no Dokploy como uma aplicação Docker.
2. Configure as variáveis de ambiente no painel do Dokploy.
3. Monte o volume `/app/data` para persistir a sessão WhatsApp entre deploys.
4. No primeiro deploy, acesse `http://<seu-ip>:3000`, faça login e escaneie o QR code.
5. A sessão fica salva em `data/.wwebjs_auth/` — o QR não será pedido novamente.

## Rodando localmente

```bash
npm install
node server.js
# Acesse http://localhost:3000
```

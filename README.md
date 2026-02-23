# Luritinha Auth Server

Servidor OAuth da Twitch para o bot Discord Luritinha.  
Hospedado no [Render](https://render.com) — **gratuito**.

## 🚀 Como fazer o deploy no Render

1. Faça upload desta pasta (`auth/`) para um repositório GitHub.
2. Acesse [render.com](https://render.com) e crie um **New Web Service**.
3. Conecte o repositório GitHub.
4. Configure:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: Free
5. Adicione as variáveis de ambiente do `.env.example` no painel do Render.
6. Ao criar o serviço, a URL será: `https://SEU-PROJETO.onrender.com`
7. **Importante**: Adicione a URL do callback na Twitch Developer Console:
   - URL: `https://SEU-PROJETO.onrender.com/callback`
8. No `.env` do bot Discord, adicione:
   ```
   TWITCH_AUTH_URL=https://SEU-PROJETO.onrender.com
   TWITCH_AUTH_SECRET=luritinha_super_secret_2026
   ```

## 📡 Endpoints

| Endpoint | Método | Descrição |
|----------|--------|-----------|
| `/` | GET | Health check |
| `/authorize` | GET | Inicia o fluxo OAuth — redireciona para a Twitch |
| `/callback` | GET | Recebe o código da Twitch e salva no Supabase |
| `/profiles?secret=SEU_SECRET` | GET | Lista perfis autorizados (uso interno do bot) |

## 🗃️ Supabase — Tabela necessária

Execute esta SQL no Supabase para criar a tabela:

```sql
CREATE TABLE twitch_auth_profiles (
  id SERIAL PRIMARY KEY,
  twitch_user_id TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT,
  avatar TEXT,
  email TEXT,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  client_id TEXT,
  client_secret TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

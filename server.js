require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI; // ex: https://seu-projeto.onrender.com/callback

// --- HEALTH CHECK ---
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Luritinha Auth Server', time: new Date().toISOString() });
});

// --- STEP 1: Inicia o OAuth ---
// O bot Discord gera este link e exibe como botão "Autorizar"
app.get('/authorize', (req, res) => {
    // Scopes necessários:
    // channel:read:subscriptions → ver quem é sub
    // user:read:email → dados do usuário
    // moderator:read:followers → ver seguidores
    const scopes = [
        'channel:read:subscriptions',
        'user:read:email',
        'moderator:read:followers',
        'bits:read'
    ].join(' ');

    const url = `https://id.twitch.tv/oauth2/authorize?`
        + `client_id=${TWITCH_CLIENT_ID}`
        + `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
        + `&response_type=code`
        + `&scope=${encodeURIComponent(scopes)}`;

    res.redirect(url);
});

// --- STEP 2: Callback da Twitch ---
app.get('/callback', async (req, res) => {
    const { code, error } = req.query;

    if (error || !code) {
        return res.status(400).send(`
            <html><body style="font-family:sans-serif;background:#0e0e10;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                    <h1 style="color:#9147ff">❌ Autorização Cancelada</h1>
                    <p>Você cancelou a autorização. Pode fechar esta aba.</p>
                </div>
            </body></html>
        `);
    }

    try {
        // 1. Troca o código pelo token
        const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
            params: {
                client_id: TWITCH_CLIENT_ID,
                client_secret: TWITCH_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: REDIRECT_URI
            }
        });

        const { access_token, refresh_token } = tokenRes.data;

        // 2. Busca os dados do usuário
        const userRes = await axios.get('https://api.twitch.tv/helix/users', {
            headers: {
                'Authorization': `Bearer ${access_token}`,
                'Client-Id': TWITCH_CLIENT_ID
            }
        });

        const user = userRes.data.data[0];
        if (!user) throw new Error('Usuário não encontrado na Twitch.');

        // 3. Salva no Supabase na tabela twitch_auth_profiles
        const profileData = {
            twitch_user_id: user.id,
            username: user.login,
            display_name: user.display_name,
            avatar: user.profile_image_url,
            email: user.email || null,
            access_token,
            refresh_token,
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        const { error: dbError } = await supabase
            .from('twitch_auth_profiles')
            .upsert(profileData, { onConflict: 'twitch_user_id' });

        if (dbError) throw dbError;

        // 4. Resposta de sucesso
        return res.send(`
            <html><body style="font-family:sans-serif;background:#0e0e10;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;max-width:500px;">
                    <img src="${user.profile_image_url}" style="border-radius:50%;width:80px;height:80px;border:3px solid #9147ff;">
                    <h1 style="color:#9147ff">✅ Autorizado!</h1>
                    <p>Olá, <strong>${user.display_name}</strong>!</p>
                    <p>Sua conta Twitch foi vinculada com sucesso ao bot.</p>
                    <p style="color:#888;font-size:0.9em;">Use o botão <strong>Atualizar</strong> no Discord para ver o novo perfil.<br>Você pode fechar esta aba.</p>
                    <div style="margin-top:20px;padding:10px;background:#1a1a2e;border-radius:8px;border:1px solid #9147ff33;">
                        <small style="color:#9147ff">🔒 Seus dados estão seguros e protegidos.</small>
                    </div>
                </div>
            </body></html>
        `);

    } catch (err) {
        console.error('[OAuth] Erro no callback:', err.message);
        return res.status(500).send(`
            <html><body style="font-family:sans-serif;background:#0e0e10;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                    <h1 style="color:#ff4444">⚠️ Erro</h1>
                    <p>Ocorreu um erro ao processar sua autorização.</p>
                    <p style="color:#888;font-size:0.9em;">${err.message}</p>
                </div>
            </body></html>
        `);
    }
});

// --- ENDPOINT: Lista perfis autorizados (usado pelo bot para atualizar) ---
app.get('/profiles', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
        .from('twitch_auth_profiles')
        .select('twitch_user_id, username, display_name, avatar, access_token, refresh_token, client_id, client_secret, created_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ profiles: data });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Auth] Servidor OAuth rodando na porta ${PORT}`);
    console.log(`[Auth] Callback URL: ${REDIRECT_URI}`);
});

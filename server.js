require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

const YT_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || REDIRECT_URI;

// --- VALIDATION ---
if (!TWITCH_CLIENT_ID || !REDIRECT_URI || !process.env.SUPABASE_URL) {
    console.warn('⚠️ [AUTH] Variáveis Twitch faltando.');
}
if (!YT_CLIENT_ID || !YT_CLIENT_SECRET) {
    console.warn('⚠️ [AUTH] Variáveis YouTube faltando.');
}

// --- HEALTH CHECK ---
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'Luritinha Auth Server', time: new Date().toISOString() });
});

// --- YOUTUBE OAUTH ---
app.get('/yt-authorize', (req, res) => {
    if (!YT_CLIENT_ID) return res.status(500).send('YouTube Client ID não configurado.');
    const scopes = [
        'https://www.googleapis.com/auth/youtube.readonly'
    ].join(' ');
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${YT_CLIENT_ID}&redirect_uri=${encodeURIComponent(YT_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;
    res.redirect(url);
});

app.get('/yt-callback', async (req, res) => {
    const { code, error } = req.query;

    if (error || !code) {
        return res.status(400).send(`
            <html><body style="font-family:sans-serif;background:#0e0e10;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                    <h1 style="color:#ff0000">❌ Autorização Cancelada</h1>
                    <p>Você cancelou a autorização do YouTube. Pode fechar esta aba.</p>
                </div>
            </body></html>
        `);
    }

    try {
        // 1. Troca o código por tokens
        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: YT_CLIENT_ID,
            client_secret: YT_CLIENT_SECRET,
            redirect_uri: YT_REDIRECT_URI,
            grant_type: 'authorization_code'
        });

        const { access_token, refresh_token, expires_in } = tokenRes.data;

        // 2. Busca dados do canal YouTube
        const channelRes = await axios.get('https://www.googleapis.com/youtube/v3/channels', {
            params: { part: 'snippet,statistics', mine: true },
            headers: { 'Authorization': `Bearer ${access_token}` }
        });

        const channel = channelRes.data.items?.[0];
        if (!channel) throw new Error('Nenhum canal YouTube encontrado para essa conta.');

        // 3. Salva no Supabase
        const profileData = {
            youtube_channel_id: channel.id,
            title: channel.snippet.title,
            description: channel.snippet.description?.substring(0, 200) || '',
            avatar: channel.snippet.thumbnails?.high?.url || channel.snippet.thumbnails?.default?.url || null,
            custom_url: channel.snippet.customUrl || null,
            subscriber_count: parseInt(channel.statistics.subscriberCount) || 0,
            video_count: parseInt(channel.statistics.videoCount) || 0,
            access_token,
            refresh_token: refresh_token || null,
            expires_at: new Date(Date.now() + (expires_in * 1000)).toISOString(),
            updated_at: new Date().toISOString()
        };

        const { error: dbError } = await supabase
            .from('yt_auth_profiles')
            .upsert(profileData, { onConflict: 'youtube_channel_id' });

        if (dbError) throw dbError;

        // 4. Resposta de sucesso
        return res.send(`
            <html><body style="font-family:sans-serif;background:#0e0e10;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;max-width:500px;">
                    <img src="${profileData.avatar}" style="border-radius:50%;width:80px;height:80px;border:3px solid #ff0000;">
                    <h1 style="color:#ff0000">✅ YouTube Autorizado!</h1>
                    <p>Canal: <strong>${profileData.title}</strong></p>
                    <p>${profileData.subscriber_count.toLocaleString()} inscritos · ${profileData.video_count} vídeos</p>
                    <p style="color:#888;font-size:0.9em;">Use o botão <strong>Sincronizar</strong> no Discord para vincular este canal.<br>Você pode fechar esta aba.</p>
                    <div style="margin-top:20px;padding:10px;background:#1a1a2e;border-radius:8px;border:1px solid #ff000033;">
                        <small style="color:#ff4444">🔒 Seus dados estão seguros e protegidos.</small>
                    </div>
                </div>
            </body></html>
        `);

    } catch (err) {
        console.error('[YT-OAuth] Erro no callback:', err.response?.data || err.message);
        return res.status(500).send(`
            <html><body style="font-family:sans-serif;background:#0e0e10;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
                <div style="text-align:center;">
                    <h1 style="color:#ff4444">⚠️ Erro</h1>
                    <p>Ocorreu um erro ao processar sua autorização YouTube.</p>
                    <p style="color:#888;font-size:0.9em;">${err.message}</p>
                </div>
            </body></html>
        `);
    }
});

// --- ENDPOINT: Lista perfis YouTube autorizados ---
app.get('/yt-profiles', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.TWITCH_AUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
        .from('yt_auth_profiles')
        .select('youtube_channel_id, title, avatar, custom_url, subscriber_count, video_count, access_token, refresh_token, expires_at');

    if (error) return res.status(500).json({ error: error.message });
    res.json({ profiles: data || [] });
});

// --- ENDPOINT: Remove um perfil YouTube permanentemente ---
app.delete('/yt-profiles/:channel_id', async (req, res) => {
    const { secret } = req.query;
    const { channel_id } = req.params;

    if (secret !== process.env.TWITCH_AUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { error } = await supabase
            .from('yt_auth_profiles')
            .delete()
            .eq('youtube_channel_id', channel_id);

        if (error) throw error;
        res.json({ success: true, message: `Perfil YouTube ${channel_id} removido permanentemente.` });
    } catch (err) {
        console.error('[YT-AUTH] Erro ao deletar:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT: Refresh token YouTube ---
app.post('/yt-refresh', async (req, res) => {
    const { secret, channel_id } = req.query;
    if (secret !== process.env.TWITCH_AUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { data: profile, error } = await supabase
            .from('yt_auth_profiles')
            .select('refresh_token')
            .eq('youtube_channel_id', channel_id)
            .single();

        if (error || !profile?.refresh_token) return res.status(404).json({ error: 'Perfil não encontrado ou sem refresh token.' });

        const tokenRes = await axios.post('https://oauth2.googleapis.com/token', {
            client_id: YT_CLIENT_ID,
            client_secret: YT_CLIENT_SECRET,
            refresh_token: profile.refresh_token,
            grant_type: 'refresh_token'
        });

        const { access_token, expires_in } = tokenRes.data;

        await supabase.from('yt_auth_profiles').update({
            access_token,
            expires_at: new Date(Date.now() + (expires_in * 1000)).toISOString(),
            updated_at: new Date().toISOString()
        }).eq('youtube_channel_id', channel_id);

        res.json({ access_token, expires_in });
    } catch (err) {
        console.error('[YT-Refresh] Erro:', err.response?.data || err.message);
        res.status(500).json({ error: err.message });
    }
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
app.get('/twitch-oauth-callback', async (req, res) => {
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

// --- ENDPOINT: Remove um perfil permanentemente (usado pelo bot) ---
app.delete('/profiles/:username', async (req, res) => {
    const { secret } = req.query;
    const { username } = req.params;

    if (secret !== process.env.TWITCH_AUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    try {
        const { error } = await supabase
            .from('twitch_auth_profiles')
            .delete()
            .eq('username', username);

        if (error) throw error;
        res.json({ success: true, message: `Perfil ${username} removido permanentemente.` });
    } catch (err) {
        console.error('[AUTH] Erro ao deletar:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- ENDPOINT: Lista perfis autorizados (usado pelo bot para atualizar) ---
app.get('/profiles', async (req, res) => {
    const { secret } = req.query;
    if (secret !== process.env.TWITCH_AUTH_SECRET) return res.status(401).json({ error: 'Unauthorized' });

    const { data, error } = await supabase
        .from('twitch_auth_profiles')
        .select('twitch_user_id, username, display_name, avatar, access_token, refresh_token, client_id, client_secret, created_at');

    if (error) {
        console.error('[AUTH] Erro ao buscar perfis no Supabase:', error.message);
        return res.status(500).json({ error: 'Erro no Banco de Dados', details: error.message });
    }
    res.json({ profiles: data || [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Auth] Servidor OAuth rodando na porta ${PORT}`);
    console.log(`[Auth] Callback URL: ${REDIRECT_URI}`);
});

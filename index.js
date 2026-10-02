require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration des variables d'environnement ---
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const MIKROTIK_SECRET = process.env.MIKROTIK_SYNC_SECRET || process.env.API_TOKEN;
const WORTIS_BASE_URL = "https://devhub.wortis.cg";

// Initialisation Supabase
const supabase = (SUPABASE_URL && SUPABASE_KEY) 
    ? createClient(SUPABASE_URL, SUPABASE_KEY) 
    : null;

// Initialisation Twilio
const twilioNumber = process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_NUMBER || process.env.TWILIO_FROM;
const twilioClient = (process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN)
    ? twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

// --- Rate Limiting (Protection contre le déni de service et le spam) ---
const paymentLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 10, // Max 10 demandes de paiement par IP
    message: { error: "Trop de requêtes de paiement initiées. Veuillez réessayer dans quelques minutes." },
    standardHeaders: true,
    legacyHeaders: false,
});

const statusLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // Max 60 vérifications par minute par IP (polling du portail captif)
    message: { error: "Trop de requêtes de vérification. Ralentissez la cadence." },
    standardHeaders: true,
    legacyHeaders: false,
});

// --- Middleware d'authentification pour les requêtes MikroTik ---
const verifyMikrotikAuth = (req, res, next) => {
    if (!MIKROTIK_SECRET) {
        console.warn("⚠️ Attention : MIKROTIK_SYNC_SECRET n'est pas configuré dans les variables d'environnement.");
        return res.status(500).send("error_config_server");
    }

    // Récupération du token depuis :
    // 1. Header Authorization: Bearer <TOKEN>
    // 2. Header X-Sixif-Secret ou X-Mikrotik-Secret
    // 3. Query params: ?token=... ou ?secret=...
    const authHeader = req.headers['authorization'];
    const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const headerToken = req.headers['x-sixif-secret'] || req.headers['x-mikrotik-secret'];
    const queryToken = req.query.token || req.query.secret;

    const providedToken = bearerToken || headerToken || queryToken;

    if (!providedToken || providedToken !== MIKROTIK_SECRET) {
        console.warn(`⛔ [ACCÈS REFUSÉ] Requête non autorisée vers ${req.path} depuis l'IP ${req.ip}`);
        return res.status(401).send("unauthorized");
    }

    next();
};

// --- Générateur de code ticket (6 caractères alphanumériques sans ambiguïté) ---
const generateTicketCode = () => {
    // Exclusion des caractères ambigus comme 0/O et 1/I pour faciliter la saisie sur mobile
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

// Configuration des forfaits Sixif / Bigo Wifi
const plans = {
    '1jour': { name: "1 JOUR", price: 50, seconds: 86400, speed: '2M' },
    '1semaine': { name: "1 SEMAINE", price: 1200, seconds: 604800, speed: '2M' },
    '1mois': { name: "1 MOIS", price: 4200, seconds: 2592000, speed: '3M' }
};

// Fonction pour récupérer le Token Wortis
async function getWortisToken() {
    try {
        const res = await axios.post(`${WORTIS_BASE_URL}/token`, {}, {
            headers: { 
                'accept': 'application/json', 
                'apikey': process.env.WORTIS_API_KEY, 
                'apinumc': process.env.WORTIS_API_NUMC 
            },
            timeout: 10000
        });
        return res.data.access_token;
    } catch (error) {
        console.error("❌ Erreur récupération Token Wortis:", error.message);
        return null;
    }
}

// --- ROUTE HEALTHCHECK (Surveillance serveur Fly.io / Uptime) ---
app.get('/health', (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "sixif-bigo-wifi-api",
        timestamp: new Date().toISOString()
    });
});

// --- 1. ROUTE DE SYNCHRONISATION MIKROTIK (Sécurisée & Multi-sites) ---
// Le MikroTik appelle cette URL toutes les X minutes avec son site_id et son token
app.get('/sync_mikrotik', verifyMikrotikAuth, async (req, res) => {
    const siteId = req.query.site_id || req.headers['x-site-id'];

    if (!siteId) {
        console.warn("⚠️ Paramètre 'site_id' manquant lors de la synchro MikroTik");
        return res.status(400).send("error_missing_site_id");
    }

    try {
        const nowIso = new Date().toISOString();
        console.log(`📡 Synchro MikroTik demandée pour le site : [${siteId}] à ${nowIso}`);

        if (!supabase) {
            return res.status(500).send("error_db_config");
        }

        // 1. Récupération uniquement des tickets PAYÉS, du SITE CONCERNÉ et NON EXPIRÉS
        const { data: activeTickets, error } = await supabase
            .from('wifi_subscriptions')
            .select('ticket_code, speed_limit, remaining_seconds, expires_at')
            .eq('site_id', siteId)
            .ilike('status', 'paid')
            .gt('expires_at', nowIso);

        if (error) {
            console.error("❌ Erreur Supabase lors de la synchro:", error);
            return res.status(500).send("error_db");
        }

        // 2. Nettoyage asynchrone : Marquer les anciens tickets comme 'expired' pour soulager la base
        supabase
            .from('wifi_subscriptions')
            .update({ status: 'expired' })
            .eq('site_id', siteId)
            .ilike('status', 'paid')
            .lte('expires_at', nowIso)
            .then(() => {})
            .catch(e => console.error("Erreur auto-expiration tickets:", e.message));

        // 3. Formatage de la réponse pour MikroTik : "CODE,VITESSE,SECONDESs|"
        let output = "";
        if (activeTickets && activeTickets.length > 0) {
            activeTickets.forEach(t => {
                const code = t.ticket_code;
                const speed = t.speed_limit || "2M";
                const seconds = t.remaining_seconds || 3600;
                if (code) {
                    output += `${code},${speed},${seconds}s|`;
                }
            });
        }

        console.log(`✅ Synchro site [${siteId}] : ${activeTickets ? activeTickets.length : 0} ticket(s) actif(s) renvoyé(s)`);
        res.setHeader('Content-Type', 'text/plain');
        res.status(200).send(output);

    } catch (err) {
        console.error("❌ Erreur Serveur Synchro:", err);
        res.status(500).send("error_server");
    }
});

// --- 2. ROUTE GÉNÉRATION TICKET & INITIATION PAIEMENT ---
app.post('/generate_ticket', paymentLimiter, async (req, res) => {
    const { tel, plan, site_id } = req.body; 

    if (!tel || !plan) {
        return res.status(400).json({ error: "Numéro de téléphone et forfait obligatoires" });
    }
    
    const selectedPlan = plans[plan];
    if (!selectedPlan) {
        return res.status(400).json({ error: "Forfait sélectionné invalide" });
    }

    const finalSiteId = site_id || "BIGO_BRAZZA_MAIN";
    const operator = tel.startsWith('06') ? "mtn" : "airtel";
    const ticketCode = generateTicketCode();
    const externalRef = `SIXIF_${Date.now()}`;

    try {
        const token = await getWortisToken();
        if (!token) throw new Error("Impossible d'obtenir le token Wortis");

        // Envoi du Push Money vers Wortis
        const pushRes = await axios.post(`${WORTIS_BASE_URL}/push/money`, {
            "operator": operator,
            "clientkey": "wortis",
            "tel": tel,
            "montant": selectedPlan.price,
            "reference": externalRef,
            "devis": "XAF",
            "description": `SIXIF WIFI - ${selectedPlan.name}`
        }, { 
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000 
        });

        const wortisId = pushRes.data.response.data?.transaction?.id || pushRes.data.response.transID;

        // Insertion dans Supabase
        const { error: insertError } = await supabase.from('wifi_subscriptions').insert([{
            phone: tel,
            plan: plan,
            ticket_code: ticketCode,
            payment_ref: externalRef,
            wortis_id: wortisId,
            status: 'pending',
            remaining_seconds: selectedPlan.seconds,
            speed_limit: selectedPlan.speed,
            payment_method: operator,
            site_id: finalSiteId,
            expires_at: new Date(Date.now() + selectedPlan.seconds * 1000).toISOString()
        }]);

        if (insertError) throw insertError;

        res.json({ success: true, payment_ref: externalRef });
        
    } catch (error) {
        console.error("❌ Erreur lors de la génération du ticket:", error.message);
        res.status(500).json({ error: "Erreur lors de l'initiation du paiement" });
    }
});

// --- 3. ROUTE VÉRIFICATION DU STATUT DU PAIEMENT ---
app.post('/check_payment', statusLimiter, async (req, res) => {
    const { payment_ref } = req.body;
    if (!payment_ref) {
        return res.status(400).json({ error: "payment_ref manquant" });
    }
    
    try {
        const { data: sub, error: subError } = await supabase
            .from('wifi_subscriptions')
            .select('ticket_code, wortis_id, status, phone, plan, payment_method, expires_at')
            .eq('payment_ref', payment_ref)
            .single();

        if (subError || !sub) {
            return res.status(404).json({ error: "Transaction introuvable" });
        }
        
        // Si déjà marqué payé en base
        if (sub.status === 'paid') {
            return res.json({ success: true, status: 'paid', ticket_code: sub.ticket_code });
        }

        const token = await getWortisToken();
        if (!token) throw new Error("Impossible de vérifier auprès de Wortis (Token indisponible)");

        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            "operator": sub.payment_method,
            "clientkey": "wortis",
            "id_wp": sub.wortis_id
        }, { 
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000
        });

        const wortisData = response.data.response;
        let isSuccess = false;

        console.log("Vérification statut Wortis:", JSON.stringify(wortisData));

        if (wortisData.data && wortisData.data.transaction) {
            // Statut Airtel : "TS" = Transaction Successful
            if (wortisData.data.transaction.status === "TS") isSuccess = true;
        } else if (wortisData.status === "SUCCESSFUL") {
            // Statut MTN : "SUCCESSFUL"
            isSuccess = true;
        }

        if (isSuccess) {
            // 1. Validation immédiate en base de données
            const { data: updatedTicket, error: updateError } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code')
                .single();

            if (updateError) throw updateError;

            // 2. Envoi du SMS au client (dans un bloc try/catch séparé pour ne pas bloquer)
            const clientPhone = sub.phone;
            const ticketCode = updatedTicket.ticket_code;
            const planName = plans[sub.plan]?.name || sub.plan;
            const expiryDate = sub.expires_at ? new Date(sub.expires_at).toLocaleDateString('fr-FR') : "N/A";

            try {
                if (clientPhone.startsWith('06') && twilioClient) {
                    // SMS MTN via Twilio
                    await twilioClient.messages.create({
                        body: `SIXIF WIFI : Votre ticket ${planName} est : ${ticketCode}. Valide jusqu'au ${expiryDate}.`,
                        from: twilioNumber,
                        to: `+242${clientPhone.substring(1)}`
                    });
                } else {
                    // SMS Airtel via passerelle Wortis
                    await axios.get(`${WORTIS_BASE_URL}/send/sms/airtel`, {
                        params: {
                            tel: clientPhone,
                            ticket: ticketCode,
                            validite: planName.split(' ').join('_'),
                            expire_at: expiryDate
                        },
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 8000
                    });
                }
                console.log(`📱 SMS envoyé au client (+242${clientPhone}) pour le ticket ${ticketCode}`);
            } catch (smsErr) {
                console.error("⚠️ L'envoi du SMS a échoué mais le ticket est validé:", smsErr.message);
            }

            return res.json({ 
                success: true, 
                status: 'paid', 
                ticket_code: updatedTicket.ticket_code 
            });
        }

        // Si le paiement est toujours en attente
        res.json({ success: false, status: 'pending' });

    } catch (error) {
        console.error("❌ Erreur lors de la vérification de paiement:", error.message);
        res.status(500).json({ error: "Erreur interne" });
    }
});

// --- 4. ROUTE LOG LOGIN (Appelée par MikroTik On-Login) ---
app.get('/log_login', verifyMikrotikAuth, async (req, res) => {
    const { ticket, mac, site } = req.query;
    console.log(`🔔 LOGIN : Ticket [${ticket}] - MAC: [${mac}] - Site: [${site}]`);
    
    try {
        if (!supabase) return res.status(200).send("ok");

        const { error } = await supabase
            .from('usage_logs')
            .insert([{
                ticket_code: ticket || "UNKNOWN",
                mac_address: mac || "UNKNOWN",
                site_id: site || "UNKNOWN",
                status: "Connexion"
            }]);

        if (error) throw error;
        res.status(200).send("ok");
    } catch (err) {
        console.error("❌ Erreur log_login:", err.message);
        // On renvoie 200 au MikroTik pour éviter qu'il ne bloque la connexion client
        res.status(200).send("ok_with_err");
    }
});

// --- 5. ROUTE LOGS DE DÉCONNEXION (Appelée par MikroTik On-Logout) ---
app.get('/log_session', verifyMikrotikAuth, async (req, res) => {
    const { user, uptime, bytes_in, bytes_out, mac, site } = req.query;

    try {
        if (!supabase) return res.status(200).send("ok");

        const { error } = await supabase
            .from('usage_logs')
            .insert([{
                ticket_code: user || "UNKNOWN",
                duration: uptime || "0s",
                bytes_in: parseInt(bytes_in) || 0,
                bytes_out: parseInt(bytes_out) || 0,
                mac_address: mac || "UNKNOWN",
                site_id: site || "UNKNOWN",
                status: "Deconnexion"
            }]);

        if (error) throw error;
        
        console.log(`🔕 LOGOUT : Ticket [${user}] - Durée: ${uptime} - Données: In=${bytes_in}b, Out=${bytes_out}b`);
        res.status(200).send("ok");
    } catch (err) {
        console.error("❌ Erreur log_session:", err.message);
        res.status(200).send("ok_with_err");
    }
});

// --- Lancement du serveur ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 API SIXIF / BIGO WIFI active sur le port ${PORT}`);
    console.log(`🔒 Authentification MikroTik activée (Secret requis)`);
    console.log(`📡 Prête pour la gestion Multi-Sites`);
});

const express = require('express');
const cors = require("cors");
const axios = require('axios');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration des Services ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const WORTIS_BASE_URL = "https://devhub.wortis.cg";

// Générateur de ticket Alphanumérique (6 caractères)
const generateTicketCode = () => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
};

const plans = {
  '1jour': { name: "1 JOUR", price: 200, seconds: 86400, speed: '2M/2M' },
  '1semaine': { name: "1 SEMAINE", price: 1200, seconds: 604800, speed: '2M/2M' },
  '1mois': { name: "1 MOIS", price: 4200, seconds: 2592000, speed: '3M/3M' }
};

// --- AUTHENTIFICATION WORTIS (JWT) ---
async function getWortisToken() {
    try {
        const res = await axios.post(`${WORTIS_BASE_URL}/token`, {}, {
            headers: {
                'accept': 'application/json',
                'apikey': process.env.WORTIS_API_KEY,
                'apinumc': process.env.WORTIS_API_NUMC
            },
            timeout: 5000 
        });
        return res.data.access_token;
    } catch (error) {
        console.error("❌ Erreur Auth Wortis:", error.message);
        return null;
    }
}

// --- 1. INITIALISATION DU PAIEMENT (PUSH) ---
app.post('/generate_ticket', async (req, res) => {
    const { tel, plan } = req.body; 
    const selectedPlan = plans[plan];

    if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

    let operator = tel.startsWith('06') ? "mtn" : "airtel";
    const ticketCode = generateTicketCode();
    const externalRef = `BIGO_${Date.now()}`;
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + selectedPlan.seconds);

    try {
        const token = await getWortisToken();
        if (!token) throw new Error("Impossible de générer le Token API");

        console.log(`[${operator}] Initiation Push pour ${tel}...`);

        // A. Appel PUSH avec timeout étendu pour MTN
        const pushRes = await axios.post(`${WORTIS_BASE_URL}/push/money`, {
            "operator": operator,
            "clientkey": "wortis",
            "tel": tel,
            "montant": selectedPlan.price,
            "reference": externalRef,
            "devis": "XAF",
            "description": `BIGO WIFI - ${selectedPlan.name}`
        }, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000 // 15 secondes max pour laisser USSD s'afficher
        });

        // B. Extraction ID Wortis (WP...)
        const wortisId = pushRes.data?.response?.data?.transaction?.id;
        if (!wortisId) throw new Error("ID Wortis absent de la réponse");

        // C. Insertion Atomique dans Supabase
        const { error: dbError } = await supabase.from('wifi_subscriptions').insert([{
            phone: tel,
            plan: plan,
            ticket_code: ticketCode,
            payment_ref: externalRef,
            wortis_id: wortisId,
            status: 'pending',
            remaining_seconds: selectedPlan.seconds,
            speed_limit: selectedPlan.speed,
            payment_method: operator,
            site_id: "BIGO_BRAZZA_01",
            expires_at: expiresAt.toISOString()
        }]);

        if (dbError) console.error("⚠️ Erreur Supabase (non critique):", dbError.message);

        // D. Réponse immédiate au navigateur pour lancer le Polling
        console.log(`✅ Push OK [${wortisId}] pour ${tel}`);
        return res.status(200).json({ 
            success: true, 
            payment_ref: externalRef 
        });

    } catch (error) {
        console.error("❌ Erreur /generate_ticket:", error.response?.data || error.message);
        
        // Sécurité : Si Wortis a déjà envoyé le push mais a timeout, on tente quand même
        if (error.code === 'ECONNABORTED') {
            return res.status(200).json({ success: true, payment_ref: externalRef, warning: "Timeout réseau" });
        }
        
        res.status(500).json({ error: "Impossible d'initier le paiement" });
    }
});

// --- 2. VÉRIFICATION DU PAIEMENT (POLLING) ---
app.post('/check_payment', async (req, res) => {
    const { payment_ref } = req.body;

    try {
        // A. Récupération de l'ID transaction stocké
        const { data: sub, error: fetchError } = await supabase
            .from('wifi_subscriptions')
            .select('wortis_id')
            .eq('payment_ref', payment_ref)
            .single();

        if (fetchError || !sub?.wortis_id) {
            return res.json({ success: false, status: 'pending' });
        }

        const token = await getWortisToken();
        
        // B. Vérification du statut final chez Wortis
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            "clientkey": "wortis",
            "id_wp": sub.wortis_id 
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // C. Si le client a validé son code PIN
        if (response.data.response && response.data.response.success === true) {
            
            const { data: ticket, error: updateError } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code, phone')
                .single();

            if (updateError) throw updateError;

            // D. SMS de confirmation (Twilio)
            try {
                await twilioClient.messages.create({
                    body: `Bigo Wifi : Paiement validé ! Votre code est ${ticket.ticket_code}.`,
                    from: process.env.TWILIO_NUMBER,
                    to: `+242${ticket.phone}`
                });
            } catch (smsErr) {
                console.warn("SMS non envoyé (quota épuisé)");
            }

            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }
        
        res.json({ success: false, status: 'pending' });

    } catch (error) {
        console.error("❌ Erreur /check_payment:", error.message);
        res.status(500).json({ error: "Vérification en cours..." });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Serveur BIGO opérationnel sur port ${PORT}`));

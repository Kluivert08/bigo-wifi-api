const express = require('express');
const cors = require("cors");
const axios = require('axios');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const WORTIS_BASE_URL = "https://devhub.wortis.cg";

// Fonction native pour générer le ticket à 6 caractères (Remplace nanoid)
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

// --- LOGIQUE AUTH WORTIS (TOKEN JWT) ---
async function getWortisToken() {
    try {
        const res = await axios.post(`${WORTIS_BASE_URL}/token`, {}, {
            headers: {
                'accept': 'application/json',
                'apikey': process.env.WORTIS_API_KEY,
                'apinumc': process.env.WORTIS_API_NUMC
            }
        });
        return res.data.access_token;
    } catch (error) {
        console.error("Erreur Auth Wortis:", error.response?.data || error.message);
        return null;
    }
}

// --- 1. INITIALISER LE PAIEMENT & PUSH (LOGIQUE ATOMIQUE) ---
app.post('/generate_ticket', async (req, res) => {
    const { tel, plan } = req.body; 
    const selectedPlan = plans[plan];

    if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

    let operator = null;
    if (tel.startsWith('06')) operator = "mtn";
    else if (tel.startsWith('04') || tel.startsWith('05')) operator = "airtel";

    if (!operator) return res.status(400).json({ error: "Numéro non reconnu" });

    const ticketCode = generateTicketCode();
    const externalRef = `BIGO_${Date.now()}`;
    const expiresAt = new Date();
    expiresAt.setSeconds(expiresAt.getSeconds() + selectedPlan.seconds);

    try {
        // A. On récupère le Token d'abord
        const token = await getWortisToken();
        if (!token) throw new Error("Échec récupération Token Wortis");

        // B. On lance le PUSH d'abord pour obtenir l'ID transaction (WP...)
        console.log(`Tentative de Push pour ${tel} (${operator})...`);
        const pushRes = await axios.post(`${WORTIS_BASE_URL}/push/money`, {
            "operator": operator,
            "clientkey": "wortis",
            "tel": tel,
            "montant": selectedPlan.price,
            "reference": externalRef,
            "devis": "XAF",
            "description": `BIGO WIFI - ${selectedPlan.name}`
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // C. Extraction de l'ID Wortis
        const wortisId = pushRes.data?.response?.data?.transaction?.id;
        if (!wortisId) {
            console.error("Réponse Wortis incomplète:", pushRes.data);
            throw new Error("Wortis n'a pas renvoyé d'ID de transaction");
        }

        // D. INSERTION UNIQUE DANS SUPABASE (Garantit que wortis_id n'est jamais vide)
        const { error: dbError } = await supabase.from('wifi_subscriptions').insert([{
            phone: tel,
            plan: plan,
            ticket_code: ticketCode,
            payment_ref: externalRef,
            wortis_id: wortisId, // Inséré en même temps que le reste
            status: 'pending',
            remaining_seconds: selectedPlan.seconds,
            speed_limit: selectedPlan.speed,
            payment_method: operator,
            site_id: "BIGO_BRAZZA_01",
            expires_at: expiresAt.toISOString()
        }]);

        if (dbError) throw dbError;

        console.log(`✅ Succès complet : Ref ${externalRef} liée à Wortis ${wortisId}`);
        res.json({ success: true, payment_ref: externalRef });

    } catch (error) {
        console.error("❌ Erreur Initiation:", error.response?.data || error.message);
        res.status(500).json({ error: "Impossible d'initier le paiement" });
    }
});

// --- 2. VÉRIFICATION DU PAIEMENT (POLLING) ---
app.post('/check_payment', async (req, res) => {
    const { payment_ref } = req.body;

    try {
        // A. Récupérer l'ID Wortis stocké
        const { data: sub, error: fetchError } = await supabase
            .from('wifi_subscriptions')
            .select('wortis_id')
            .eq('payment_ref', payment_ref)
            .single();

        if (fetchError || !sub || !sub.wortis_id) {
            return res.json({ success: false, status: 'pending', message: "ID Wortis non encore disponible" });
        }

        const token = await getWortisToken();
        
        // B. Vérification chez Wortis avec l'ID id_wp
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            "clientkey": "wortis",
            "id_wp": sub.wortis_id 
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // C. Si succès confirmé par Wortis (le client a tapé son code PIN)
        if (response.data.response && response.data.response.success === true) {
            
            // Mise à jour finale Supabase
            const { data: ticket, error: updateError } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code, phone')
                .single();

            if (updateError) throw updateError;

            // D. Envoi du SMS (si quotas restants)
            try {
                await twilioClient.messages.create({
                    body: `Bigo Wifi : Paiement validé ! Votre code est ${ticket.ticket_code}.`,
                    from: process.env.TWILIO_NUMBER,
                    to: `+242${ticket.phone}`
                });
            } catch (smsErr) {
                console.warn("SMS non envoyé (quota Twilio probable)");
            }

            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }
        
        res.json({ success: false, status: 'pending' });

    } catch (error) {
        console.error("Erreur Check:", error.response?.data || error.message);
        res.status(500).json({ error: "Erreur de vérification" });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 API BIGO v2 (Atomique) sur port ${PORT}`));

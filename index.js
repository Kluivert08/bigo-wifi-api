const express = require('express');
const cors = require("cors");
const axios = require('axios');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration des variables d'environnement ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const WORTIS_BASE_URL = "https://devhub.wortis.cg";

// Fonction native pour générer le ticket (Remplace nanoid)
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

// --- 1. INITIALISER LE PAIEMENT ---
app.post('/generate_ticket', async (req, res) => {
    const { tel, plan } = req.body; 
    const selectedPlan = plans[plan];

    if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

    // Détection automatique de l'opérateur
    let operator = null;
    if (tel.startsWith('06')) operator = "mtn";
    else if (tel.startsWith('04') || tel.startsWith('05')) operator = "airtel";

    if (!operator) return res.status(400).json({ error: "Numéro non reconnu" });

    const ticketCode = generateTicketCode();
    const externalRef = `BIGO_${Date.now()}`;

    try {
        // A. Sauvegarde Supabase
        const { error: dbError } = await supabase.from('wifi_subscriptions').insert([{
            phone: tel,
            plan,
            ticket_code: ticketCode,
            payment_ref: externalRef,
            status: 'pending',
            remaining_seconds: selectedPlan.seconds,
            speed_limit: selectedPlan.speed,
            payment_method: operator
        }]);
        if (dbError) throw dbError;

        // B. Token & Push
        const token = await getWortisToken();
        if (!token) throw new Error("Erreur partenaire (Auth)");

        await axios.post(`${WORTIS_BASE_URL}/push/money`, {
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

        res.json({ success: true, payment_ref: externalRef });

    } catch (error) {
        console.error("Erreur Process:", error.response?.data || error.message);
        res.status(500).json({ error: "Erreur lors de l'initiation" });
    }
});

// --- 2. VÉRIFICATION DU PAIEMENT (POLLING) ---
app.post('/check_payment', async (req, res) => {
    const { payment_ref } = req.body;

    try {
        const token = await getWortisToken();
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            "clientkey": "wortis",
            "id_wp": payment_ref 
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (response.data.response && response.data.response.success === true) {
            // Mise à jour status payé
            const { data: ticket, error } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code, phone, plan')
                .single();

            if (error) throw error;

            // Envoi SMS via Twilio
            try {
                await twilioClient.messages.create({
                    body: `Bigo Wifi : Votre code est ${ticket.ticket_code}. Profitez bien !`,
                    from: process.env.TWILIO_NUMBER,
                    to: `+242${ticket.phone}`
                });
            } catch (smsErr) { console.error("Erreur SMS:", smsErr.message); }

            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }
        res.json({ success: false, status: 'pending' });

    } catch (error) {
        console.error("Erreur Check:", error.response?.data || error.message);
        res.status(500).json({ error: "Erreur de vérification" });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 API BIGO opérationnelle sur le port ${PORT}`));

const express = require('express');
const cors = require("cors");
const axios = require('axios');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { customAlphabet } = require('nanoid');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
const generateTicketCode = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 6);
const WORTIS_BASE_URL = "https://devhub.wortis.cg";

const plans = {
  '1jour': { name: "1 JOUR", price: 200, seconds: 86400, speed: '2M/2M' },
  '1semaine': { name: "1 SEMAINE", price: 1200, seconds: 604800, speed: '2M/2M' },
  '1mois': { name: "1 MOIS", price: 4200, seconds: 2592000, speed: '3M/3M' }
};

// --- LOGIQUE D'AUTHENTIFICATION WORTIS (TOKEN) ---
async function getWortisToken() {
    try {
        const res = await axios.post(`${WORTIS_BASE_URL}/token`, {}, {
            headers: {
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

// --- 1. INITIALISER LE PAIEMENT & GÉNÉRER TICKET ---
app.post('/generate_ticket', async (req, res) => {
    const { tel, plan } = req.body; 
    const selectedPlan = plans[plan];

    if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

    // Détection automatique de l'opérateur (Sécurité Serveur)
    let operator = null;
    if (tel.startsWith('06')) operator = "mtn";
    else if (tel.startsWith('04') || tel.startsWith('05')) operator = "airtel";

    if (!operator) return res.status(400).json({ error: "Numéro non reconnu (04, 05 ou 06 requis)" });

    const ticketCode = generateTicketCode();
    const externalRef = `BGW${Date.now()}`;

    try {
        // A. Sauvegarde dans Supabase (status pending)
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

        // B. Récupération du Token JWT
        const token = await getWortisToken();
        if (!token) throw new Error("Échec d'authentification partenaire");

        // C. Appel Push Money
        await axios.post(`${WORTIS_BASE_URL}/push/money`, {
            operator: operator,
            clientkey: "wortis",
            tel: tel,
            montant: selectedPlan.price,
            reference: externalRef,
            devis: "XAF",
            description: `BIGO WIFI - ${selectedPlan.name}`
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        res.json({ success: true, payment_ref: externalRef });

    } catch (error) {
        console.error("Erreur Process:", error.response?.data || error.message);
        res.status(500).json({ error: "Impossible d'initier le paiement" });
    }
});

// --- 2. VÉRIFIER LE STATUT (POLLING) & SMS ---
app.post('/check_payment', async (req, res) => {
    const { payment_ref } = req.body;

    try {
        const token = await getWortisToken();
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            clientkey: "wortis",
            id_wp: payment_ref 
        }, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        // Si le paiement est un succès (vérifier la structure exacte de retour de Wortis)
        if (response.data.response && response.data.response.success === true) {
            
            const { data: ticket, error } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code, phone, plan')
                .single();

            if (error) throw error;

            // Envoi SMS Twilio
            try {
                await twilioClient.messages.create({
                    body: `Bigo Wifi : Code ${ticket.ticket_code} (Forfait ${ticket.plan}). Connectez-vous !`,
                    from: process.env.TWILIO_NUMBER,
                    to: `+242${ticket.phone}`
                });
            } catch (s) {}

            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }
        res.json({ success: false, status: 'pending' });

    } catch (error) {
        res.status(500).json({ error: "Erreur vérification" });
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Bigo API Active sur port ${PORT}`));

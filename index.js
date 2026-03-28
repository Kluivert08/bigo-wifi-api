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

const generateTicketCode = () => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
};

const plans = {
  '1jour': { name: "1 JOUR", price: 200, seconds: 86400, speed: '2M/2M' },
  '1semaine': { name: "1 SEMAINE", price: 1200, seconds: 604800, speed: '2M/2M' },
  '1mois': { name: "1 MOIS", price: 4200, seconds: 2592000, speed: '3M/3M' }
};

async function getWortisToken() {
    try {
        const res = await axios.post(`${WORTIS_BASE_URL}/token`, {}, {
            headers: { 'accept': 'application/json', 'apikey': process.env.WORTIS_API_KEY, 'apinumc': process.env.WORTIS_API_NUMC }
        });
        return res.data.access_token;
    } catch (error) { return null; }
}

// --- ROUTE DE SYNCHRONISATION MIKROTIK ---
app.get('/sync_mikrotik', async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('wifi_subscriptions')
            .select('ticket_code, speed_limit, remaining_seconds')
            .eq('status', 'paid');

        if (error) throw error;

        let output = "";
        
        // SECURITÉ : On ajoute toujours TEST01 pour valider que le MikroTik reçoit des données
        output += "TEST01,2M/2M,3600s|"; 

        if (data && data.length > 0) {
            data.forEach(t => {
                // On ajoute le 's' pour le format temps MikroTik
                output += `${t.ticket_code},${t.speed_limit},${t.remaining_seconds}s|`;
            });
        }
        
        console.log("Sortie MikroTik:", output);
        res.send(output);
    } catch (err) {
        res.status(500).send("error");
    }
});

// --- GENERATION TICKET & PUSH ---
app.post('/generate_ticket', async (req, res) => {
    const { tel, plan } = req.body; 
    const selectedPlan = plans[plan];
    if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

    let operator = tel.startsWith('06') ? "mtn" : "airtel";
    const ticketCode = generateTicketCode();
    const externalRef = `BIGO_${Date.now()}`;

    try {
        const token = await getWortisToken();
        const pushRes = await axios.post(`${WORTIS_BASE_URL}/push/money`, {
            "operator": operator, "clientkey": "wortis", "tel": tel,
            "montant": selectedPlan.price, "reference": externalRef,
            "devis": "XAF", "description": `BIGO WIFI - ${selectedPlan.name}`
        }, { headers: { 'Authorization': `Bearer ${token}` }, timeout: 15000 });

        let wortisId = pushRes.data.response.data?.transaction?.id || pushRes.data.response.transID;

        await supabase.from('wifi_subscriptions').insert([{
            phone: tel, plan: plan, ticket_code: ticketCode,
            payment_ref: externalRef, wortis_id: wortisId, status: 'pending',
            remaining_seconds: selectedPlan.seconds, speed_limit: selectedPlan.speed,
            payment_method: operator, site_id: "BIGO_BRAZZA_01",
            expires_at: new Date(Date.now() + selectedPlan.seconds * 1000).toISOString()
        }]);

        res.json({ success: true, payment_ref: externalRef });
    } catch (error) {
        res.status(500).json({ error: "Erreur Initiation" });
    }
});

// --- VERIFICATION PAIEMENT ---
app.post('/check_payment', async (req, res) => {
    const { payment_ref } = req.body;
    try {
        const { data: sub } = await supabase.from('wifi_subscriptions').select('wortis_id').eq('payment_ref', payment_ref).single();
        const token = await getWortisToken();
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, { "clientkey": "wortis", "id_wp": sub.wortis_id }, { headers: { 'Authorization': `Bearer ${token}` } });

        if (response.data.response?.success === true) {
            const { data: ticket } = await supabase.from('wifi_subscriptions').update({ status: 'paid' }).eq('payment_ref', payment_ref).select('ticket_code, phone').single();
            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }
        res.json({ success: false, status: 'pending' });
    } catch (error) { res.status(500).json({ error: "Erreur Check" }); }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 API BIGO v3 sur port ${PORT}`));

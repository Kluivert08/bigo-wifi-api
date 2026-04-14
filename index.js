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

// Générateur de code ticket (6 caractères alphanumériques)
const generateTicketCode = () => {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
};

// Configuration des forfaits (Plans)
const plans = {
  '1jour': { name: "1 JOUR", price: 200, seconds: 86400, speed: '2M' },
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
            }
        });
        return res.data.access_token;
    } catch (error) {
        console.error("Erreur Token Wortis:", error.message);
        return null;
    }
}

// --- 1. ROUTE DE SYNCHRONISATION MIKROTIK ---
app.get('/sync_mikrotik', async (req, res) => {
    try {
        console.log("--- Synchro MikroTik en cours ---");
        
        // On récupère tous les tickets payés (insensible à la casse)
        const { data, error } = await supabase
            .from('wifi_subscriptions')
            .select('ticket_code, speed_limit, remaining_seconds, status')
            .ilike('status', 'paid');

        if (error) {
            console.error("Erreur Supabase:", error);
            return res.status(500).send("error_db");
        }

        let output = "";
        
        // Ticket de test permanent pour valider la liaison
       // output += "TEST01,2M,3600s|"; 

        if (data && data.length > 0) {
            data.forEach(t => {
                const code = t.ticket_code || "ERR";
                const speed = t.speed_limit || "2M"; // Format propre "2M" sans slash
                const seconds = t.remaining_seconds || 3600;
                
                output += `${code},${speed},${seconds}s|`;
            });
        }
        
        console.log("Données envoyées au MikroTik:", output);
        res.send(output);

    } catch (err) {
        console.error("Erreur Serveur Synchro:", err);
        res.status(500).send("error_server");
    }
});

// --- 2. ROUTE GÉNÉRATION TICKET & PAIEMENT ---
app.post('/generate_ticket', async (req, res) => {
    // AJOUT : On récupère site_id depuis le corps de la requête (Body)
    const { tel, plan, site_id } = req.body; 
    
    const selectedPlan = plans[plan];
    if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

    // Valeur par défaut si le site_id n'est pas fourni
    const finalSiteId = site_id || "BIGO_BRAZZA_MAIN";

    let operator = tel.startsWith('06') ? "mtn" : "airtel";
    const ticketCode = generateTicketCode();
    const externalRef = `BIGO_${Date.now()}`;

    try {
        const token = await getWortisToken();
        if (!token) throw new Error("Impossible d'obtenir le token Wortis");

        // Envoi du Push Money via Wortis
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
            timeout: 15000 
        });

        let wortisId = pushRes.data.response.data?.transaction?.id || pushRes.data.response.transID;

        // Insertion dans Supabase avec le site_id DYNAMIQUE
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
            site_id: finalSiteId, // <--- C'est ici que l'ID du MikroTik est stocké
            expires_at: new Date(Date.now() + selectedPlan.seconds * 1000).toISOString()
        }]);

        if (insertError) throw insertError;

        res.json({ success: true, payment_ref: externalRef });
        
    } catch (error) {
        console.error("Erreur lors de la génération du ticket:", error.message);
        res.status(500).json({ error: "Erreur lors de l'initiation du paiement" });
    }
});

// --- 3. ROUTE VÉRIFICATION DU STATUT DU PAIEMENT ---
app.post('/check_payment', async (req, res) => {
    const { payment_ref } = req.body;
    
    try {
        const { data: sub, error: subError } = await supabase
            .from('wifi_subscriptions')
            .select('wortis_id, status, phone, plan, expires_at')
            .eq('payment_ref', payment_ref)
            .single();

        if (subError || !sub) return res.status(404).json({ error: "Transaction introuvable" });
        if (sub.status === 'paid') {
            const { data: ticket } = await supabase.from('wifi_subscriptions').select('ticket_code').eq('payment_ref', payment_ref).single();
            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }

        const token = await getWortisToken();
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            "clientkey": "wortis",
            "id_wp": sub.wortis_id
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        const wortisData = response.data.response;
        let isSuccess = false;

        // Logique Hybride
        if (wortisData.data && wortisData.data.transaction) {
            if (wortisData.data.transaction.status === "TS") isSuccess = true;
        } else if (wortisData.status === "SUCCESSFUL") {
            isSuccess = true;
        }

        if (isSuccess) {
            const { data: updatedTicket, error: updateError } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code')
                .single();

            if (updateError) throw updateError;

            // --- NOUVEAU : ENVOI DU SMS ---
            const clientPhone = sub.phone;
            const ticketCode = updatedTicket.ticket_code;
            const planName = plans[sub.plan]?.name || sub.plan;
            const expiryDate = new Date(sub.expires_at).toLocaleString('fr-FR');

            try {
                if (clientPhone.startsWith('06')) {
                    // Envoi via Twilio pour MTN
                    await twilioClient.messages.create({
                        body: `BIGO WIFI : Votre ticket ${planName} est ${ticketCode}. Valide jusqu'au ${expiryDate}. bitly.com/voirmonforfait`,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: `+242${clientPhone.substring(1)}` // Format international Congo
                    });
                    console.log(`SMS MTN envoyé au ${clientPhone}`);
                } else {
                    // Envoi via API Wortis pour Airtel
                    await axios.get(`${WORTIS_BASE_URL}/send/sms/airtel`, {
                        params: {
                            tel: clientPhone,
                            ticket: ticketCode,
                            validite: planName,
                            expire_at: expiryDate
                        },
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                    console.log(`SMS Airtel envoyé au ${clientPhone}`);
                }
            } catch (smsErr) {
                // On log l'erreur mais on ne bloque pas la réponse client car le paiement est validé
                console.error("Erreur envoi SMS:", smsErr.message);
            }

            return res.json({ 
                success: true, 
                status: 'paid', 
                ticket_code: ticketCode 
            });
        }

        res.json({ success: false, status: 'pending' });

    } catch (error) {
        console.error("Erreur lors de la vérification:", error.message);
        res.status(500).json({ error: "Erreur lors de la vérification du paiement" });
    }
});

// Lancement du serveur
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 API BIGO WIFI active sur le port ${PORT}`);
    console.log(`📡 Prête pour la gestion Multi-Sites`);
});

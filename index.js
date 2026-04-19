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
            .select('wortis_id, status, phone, plan, payment_method, expires_at')
            .eq('payment_ref', payment_ref)
            .single();

        if (subError || !sub) return res.status(404).json({ error: "Transaction introuvable" });
        
        if (sub.status === 'paid') {
            const { data: ticket } = await supabase.from('wifi_subscriptions').select('ticket_code').eq('payment_ref', payment_ref).single();
            return res.json({ success: true, status: 'paid', ticket_code: ticket.ticket_code });
        }

        const token = await getWortisToken();
        const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
            "operator": sub.payment_method,
            "clientkey": "wortis",
            "id_wp": sub.wortis_id
        }, { headers: { 'Authorization': `Bearer ${token}` } });

        const wortisData = response.data.response;
        let isSuccess = false;

        // --- DÉBOGAGE : Log de la réponse reçue pour voir la structure exacte ---
        console.log("Réponse Wortis pour Airtel/MTN:", JSON.stringify(wortisData));

        if (wortisData.data && wortisData.data.transaction) {
            // Logique Airtel : on vérifie "TS"
            if (wortisData.data.transaction.status === "TS") isSuccess = true;
        } else if (wortisData.status === "SUCCESSFUL") {
            // Logique MTN
            isSuccess = true;
        }

        if (isSuccess) {
            // 1. D'ABORD : Mise à jour Supabase (Priorité absolue)
            const { data: updatedTicket, error: updateError } = await supabase
                .from('wifi_subscriptions')
                .update({ status: 'paid' })
                .eq('payment_ref', payment_ref)
                .select('ticket_code')
                .single();

            if (updateError) throw updateError;

            // 2. ENSUITE : Tentative d'envoi SMS (dans un try/catch pour ne pas bloquer)
            const clientPhone = sub.phone;
            const ticketCode = updatedTicket.ticket_code;
            const planName = plans[sub.plan]?.name || sub.plan;
            const expiryDate = sub.expires_at ? new Date(sub.expires_at).toLocaleDateString('fr-FR') : "N/A";

            try {
                if (clientPhone.startsWith('06')) {
                    // SMS MTN via Twilio
                    await twilioClient.messages.create({
                        body: `BIGO WIFI : Votre ticket ${planName} est ${ticketCode}. Valide jusqu'au ${expiryDate}.`,
                        from: process.env.TWILIO_PHONE_NUMBER,
                        to: `+242${clientPhone.substring(1)}`
                    });
                } else {
                    // SMS Airtel via Wortis (Nettoyage des paramètres pour éviter la 422)
                    await axios.get(`${WORTIS_BASE_URL}/send/sms/airtel`, {
                        params: {
                            tel: clientPhone,
                            ticket: ticketCode,
                            validite: planName.split(' ').join('_'), // Pas d'espaces
                            expire_at: expiryDate
                        },
                        headers: { 'Authorization': `Bearer ${token}` }
                    });
                }
                console.log("SMS envoyé avec succès");
            } catch (smsErr) {
                // Si l'SMS échoue (Erreur 422 par exemple), on log mais on ne crash pas
                console.error("L'envoi du SMS a échoué mais le ticket est validé:", smsErr.message);
            }

            // On répond toujours succès si isSuccess était vrai
            return res.json({ 
                success: true, 
                status: 'paid', 
                ticket_code: updatedTicket.ticket_code 
            });
        }

        // Si ce n'est pas encore SUCCESSFUL ou TS
        res.json({ success: false, status: 'pending' });

    } catch (error) {
        console.error("Erreur critique lors de la vérification:", error.message);
        res.status(500).json({ error: "Erreur interne" });
    }
});

// --- 4. ROUTE LOG LOGIN (Appelée par MikroTik On Login) ---
app.get('/log_login', async (req, res) => {
    const { ticket, mac, site } = req.query;
    console.log(`🔔 LOGIN : Ticket ${ticket} sur appareil ${mac} (Site: ${site})`);
    
    try {
        const { error } = await supabase
            .from('usage_logs')
            .insert([{
                ticket_code: ticket,
                mac_address: mac,
                site_id: site || "UNKNOWN",
                status: "Connexion" // Marqueur de début
            }]);

        if (error) throw error;
        res.status(200).send("ok");
    } catch (err) {
        console.error("Erreur log_login:", err.message);
        res.status(500).send("error");
    }
});

// --- 5. ROUTE LOGS DE DÉCONNEXION (Appelée par MikroTik On Logout) ---
app.get('/log_session', async (req, res) => {
    const { user, uptime, bytes_in, bytes_out, mac, site } = req.query;

    try {
        const { error } = await supabase
            .from('usage_logs')
            .insert([{
                ticket_code: user,
                duration: uptime,
                bytes_in: parseInt(bytes_in) || 0,
                bytes_out: parseInt(bytes_out) || 0,
                mac_address: mac,
                site_id: site || "UNKNOWN",
                status: "Deconnexion" // Marqueur de fin avec stats
            }]);

        if (error) throw error;
        
        console.log(`🔕 LOGOUT : Ticket ${user} - Durée: ${uptime}`);
        res.status(200).send("ok");
    } catch (err) {
        console.error("Erreur log_session:", err.message);
        res.status(500).send("error");
    }
});

// Lancement du serveur
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 API BIGO WIFI active sur le port ${PORT}`);
    console.log(`📡 Prête pour la gestion Multi-Sites`);
});

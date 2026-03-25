const express = require('express');
const cors = require("cors");
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { customAlphabet } = require('nanoid');

const app = express();
app.use(express.json());
app.use(cors());

// Configuration des clients
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Univers de 6 caractères (Lettres Majuscules + Chiffres)
const generateTicketCode = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 6);

const WORTIS_BASE_URL = "https://devhub.wortis.cg";

const plans = {
  '1jour': { name: "1 Jour", price: 200, seconds: 86400, speed: '2M/2M' },
  '1semaine': { name: "1 Semaine", price: 1200, seconds: 604800, speed: '2M/2M' },
  '1mois': { name: "1 Mois", price: 4200, seconds: 2592000, speed: '3M/3M' }
};

// --- 1. INITIALISER LE PAIEMENT ---
app.post('/generate_ticket', async (req, res) => {
  const { phone, plan, method } = req.body; 
  const selectedPlan = plans[plan];

  if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

  const ticketCode = generateTicketCode();
  const externalRef = `BIGO_${Date.now()}`; // Référence unique pour cette transaction

  try {
    // On crée le ticket en mode "pending"
    const { error: dbError } = await supabase
      .from('wifi_subscriptions')
      .insert([{
        phone,
        plan,
        ticket_code: ticketCode,
        payment_ref: externalRef,
        status: 'pending',
        remaining_seconds: selectedPlan.seconds,
        speed_limit: selectedPlan.speed,
        payment_method: method
      }]);

    if (dbError) throw dbError;

    // Appel à Wortispay (Push Mobile Money)
    const response = await axios.post(`${WORTIS_BASE_URL}/push/money`, {
      operator: method, // 'mtn' ou 'airtel'
      phone: phone.replace('+', ''), 
      montant: selectedPlan.price,
      reference: externalRef,
      devis: "XAF",
      description: `Bigo Wifi - ${selectedPlan.name}`
    }, {
      headers: {
        'apikey': process.env.WORTIS_API_KEY,
        'apinumc': process.env.WORTIS_API_NUMC,
        'Content-Type': 'application/json'
      }
    });

    res.json({ 
      success: true, 
      payment_ref: externalRef, // On donne la réf au front-end
      message: "Veuillez valider le paiement sur votre mobile" 
    });

  } catch (error) {
    console.error("Erreur Wortis:", error.response?.data || error.message);
    res.status(500).json({ error: "Impossible d'initier le paiement" });
  }
});

// --- 2. VÉRIFIER LE STATUT ET ACTIVER ---
app.post('/check_payment', async (req, res) => {
  const { payment_ref, method } = req.body;

  try {
    // On questionne Wortis sur le statut de cette référence
    const response = await axios.post(`${WORTIS_BASE_URL}/check/push/money`, {
      operator: method,
      clientkey: "wortis",
      id_wp: payment_ref 
    }, {
      headers: {
        'apikey': process.env.WORTIS_API_KEY,
        'apinumc': process.env.WORTIS_API_NUMC
      }
    });

    // Si Wortis confirme le succès
    if (response.data.response && response.data.response.success === true) {
      
      // On passe le ticket en 'paid'
      const { data, error } = await supabase
        .from('wifi_subscriptions')
        .update({ status: 'paid' })
        .eq('payment_ref', payment_ref)
        .select('ticket_code')
        .single();

      if (error) throw error;

      return res.json({ 
        success: true, 
        status: 'paid', 
        ticket_code: data.ticket_code 
      });
    } else {
      return res.json({ success: false, status: 'pending' });
    }

  } catch (error) {
    console.error("Erreur Check:", error.message);
    res.status(500).json({ error: "Erreur lors de la vérification" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Bigo API sur port ${PORT}`));

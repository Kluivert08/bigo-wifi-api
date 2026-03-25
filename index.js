const express = require('express');
const cors = require("cors");
const axios = require('axios');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');
const { customAlphabet } = require('nanoid');

const app = express();
app.use(express.json());
app.use(cors());

// --- Configuration des clients ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);

// Univers de 6 caractères (Chiffres + Lettres Majuscules) pour les tickets
const generateTicketCode = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 6);

const WORTIS_BASE_URL = "https://devhub.wortis.cg";

// Définition des forfaits
const plans = {
  '1jour': { name: "1 JOUR", price: 200, seconds: 86400, speed: '2M/2M' },
  '1semaine': { name: "1 SEMAINE", price: 1200, seconds: 604800, speed: '2M/2M' },
  '1mois': { name: "1 MOIS", price: 4200, seconds: 2592000, speed: '3M/3M' }
};

// --- 1. ENDPOINT : GÉNÉRATION ET INITIALISATION PAIEMENT ---
app.post('/generate_ticket', async (req, res) => {
  const { phone, plan, method } = req.body; // method: 'mtn' ou 'airtel'
  const selectedPlan = plans[plan];

  if (!selectedPlan) return res.status(400).json({ error: "Plan invalide" });

  const ticketCode = generateTicketCode();
  const externalRef = `BIGO_${Date.now()}`; // Référence pour Wortis

  try {
    // A. Insertion dans Supabase en mode 'pending'
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

    // B. Appel API Wortispay (Push Money)
    const response = await axios.post(`${WORTIS_BASE_URL}/push/money`, {
      operator: method,
      phone: phone.replace('+', ''), // Nettoyage du numéro
      montant: selectedPlan.price,
      reference: externalRef,
      devis: "XAF",
      description: `Bigo Wifi - Forfait ${selectedPlan.name}`
    }, {
      headers: {
        'apikey': process.env.WORTIS_API_KEY,
        'apinumc': process.env.WORTIS_API_NUMC,
        'Content-Type': 'application/json'
      }
    });

    res.json({ 
      success: true, 
      payment_ref: externalRef, 
      message: "Veuillez valider le paiement sur votre téléphone" 
    });

  } catch (error) {
    console.error("Erreur Initiation:", error.response?.data || error.message);
    res.status(500).json({ error: "Erreur lors de l'initiation du paiement" });
  }
});

// --- 2. ENDPOINT : VÉRIFICATION, ACTIVATION ET SMS ---
app.post('/check_payment', async (req, res) => {
  const { payment_ref, method } = req.body;

  try {
    // A. On interroge Wortispay sur le statut
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

    // B. Si succès confirmé par Wortis
    if (response.data.response && response.data.response.success === true) {
      
      // Mettre à jour le ticket en 'paid'
      const { data: ticket, error } = await supabase
        .from('wifi_subscriptions')
        .update({ status: 'paid' })
        .eq('payment_ref', payment_ref)
        .select('ticket_code, phone, plan')
        .single();

      if (error) throw error;

      // C. Envoi du SMS de confirmation via Twilio
      try {
        await twilioClient.messages.create({
          body: `Bigo Wifi : Votre code est ${ticket.ticket_code}. Forfait ${ticket.plan}.`,
          from: process.env.TWILIO_NUMBER,
          to: ticket.phone
        });
      } catch (smsErr) {
        console.error("Erreur SMS (mais paiement OK):", smsErr.message);
      }

      return res.json({ 
        success: true, 
        status: 'paid', 
        ticket_code: ticket.ticket_code 
      });
    } else {
      return res.json({ success: false, status: 'pending' });
    }

  } catch (error) {
    console.error("Erreur Vérification:", error.message);
    res.status(500).json({ error: "Erreur lors de la vérification du statut" });
  }
});

// Santé du serveur
app.get('/health', (req, res) => res.json({ status: 'Bigo API is alive' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🚀 Bigo Wifi API sur port ${PORT}`));

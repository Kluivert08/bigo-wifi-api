// index.js
const express = require('express');
const cors = require("cors");
const bodyParser = require('body-parser');
const { RouterOSClient } = require('node-routeros'); // npm i node-routeros
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.json());

app.use(cors({
  origin: "*",
  methods: ["GET","POST"],
  allowedHeaders: ["Content-Type","Authorization"]
}));

// === Supabase config ===
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const supabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// === Environment Variables MikroTik & Twilio (placeholders) ===
const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASS = process.env.MIKROTIK_PASS;

const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

// === API Token pour sécuriser les endpoints ===
const API_TOKEN = process.env.API_TOKEN;

// === Utils: Génération ticket unique ===
function generateTicket() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let ticket = "BG-";
  for (let i = 0; i < 4; i++) ticket += chars.charAt(Math.floor(Math.random() * chars.length));
  ticket += "-";
  for (let i = 0; i < 3; i++) ticket += chars.charAt(Math.floor(Math.random() * chars.length));
  return ticket;
}

async function createUniqueTicket() {
  let ticket;
  let exists = true;

  while (exists) {
    ticket = generateTicket();
    const { data } = await supabaseClient
      .from("wifi_subscriptions")
      .select("ticket")
      .eq("ticket", ticket);

    if (!data || data.length === 0) exists = false;
  }

  return ticket;
}

// === Utils: calcul date expiration ===
function getExpirationDate(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

// === Endpoint test: générer ticket et enregistrer Supabase ===
app.post('/generate_ticket', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    if (!token || token !== `Bearer ${API_TOKEN}`) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { phone, plan, method: paymentMethod } = req.body;
    if (!phone || !plan) return res.status(400).json({ success: false, error: 'Missing phone or plan' });

    const plans = {
      "1jour": { name: "1 Jour", days: 1 },
      "1semaine": { name: "1 Semaine", days: 7 },
      "1mois": { name: "1 Mois", days: 30 }
    };
    const selectedPlan = plans[plan];
    if (!selectedPlan) return res.status(400).json({ success: false, error: 'Invalid plan' });

    // --- Génération ticket unique ---
    const ticket = await createUniqueTicket();

    // --- Calcul date expiration ---
    const expires_at = getExpirationDate(selectedPlan.days);

    // --- Enregistrement Supabase ---
    await supabaseClient
      .from("wifi_subscriptions")
      .insert([{  userphone: phone,
    plan: selectedPlan.name,
    payment_method: paymentMethod || null,
    ticketwifi: ticket,
    created_at: new Date(),
    expires_at: expires_at}]);

    // === PLACEHOLDER: Création utilisateur MikroTik ===
    // Uncomment & configure when credentials are ready
    /*
    const conn = new RouterOSClient({
      host: MIKROTIK_HOST,
      user: MIKROTIK_USER,
      password: MIKROTIK_PASS
    });
    await conn.connect();
    await conn.menu('/ip/hotspot/user').add({
      name: ticket,
      password: ticket,
      profile: plan
    });
    conn.close();
    */

    // === PLACEHOLDER: Envoi SMS Twilio ===
    // Uncomment & configure when Twilio keys are ready
    /*
    const client = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);
    await client.messages.create({
      to: phone,
      from: TWILIO_FROM,
      body: `Votre code Wifi : ${ticket}`
    });
    */

    res.json({ success: true, ticket });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Endpoint test: vérifier ticket login ===
app.post('/verify_ticket', async (req, res) => {
  try {
    const { ticket } = req.body;
    if (!ticket) return res.status(400).json({ success: false, error: 'Missing ticket' });

    const { data, error } = await supabaseClient
      .from("wifi_subscriptions")
      .select("*")
      .eq("ticket", ticket)
      .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Ticket invalide' });

    res.json({ success: true, plan: data.plan, expires_at: data.expires_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Health check ---
app.get("/", (req, res) => res.send("Bigo Wifi API running 🚀"));

// --- Lancer le serveur ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));








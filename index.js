// index.js

const express = require('express');
const bodyParser = require('body-parser');
const { RouterOSClient } = require('node-routeros');
const twilio = require('twilio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(bodyParser.json());

/* ================================
   VARIABLES ENVIRONNEMENT
================================ */

const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASS = process.env.MIKROTIK_PASS;

const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

const API_TOKEN = process.env.API_TOKEN;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

/* ================================
   INIT SERVICES
================================ */

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

/* ================================
   GENERATEUR TICKET WIFI
   FORMAT : BG-7K4P-9LX
================================ */

function generateTicket() {

  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  function randomPart(length) {
    let part = "";
    for (let i = 0; i < length; i++) {
      part += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return part;
  }

  return `BG-${randomPart(4)}-${randomPart(3)}`;
}

/* ================================
   VERIFIER UNICITE TICKET
================================ */

async function createUniqueTicket() {

  let ticket;
  let exists = true;

  while (exists) {

    ticket = generateTicket();

    const { data, error } = await supabase
      .from("wifi_subscriptions")
      .select("ticket")
      .eq("ticket", ticket);

    if (!data || data.length === 0) {
      exists = false;
    }

  }

  return ticket;
}

/* ================================
   CALCUL EXPIRATION
================================ */

function getExpiration(days) {

  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;

}

/* ================================
   ENDPOINT CREATION WIFI
================================ */

app.post('/mikrotik/add_user', async (req, res) => {

  try {

    const token = req.headers['authorization'];

    if (!token || token !== `Bearer ${API_TOKEN}`) {
      return res.status(401).json({ success:false, error:"Unauthorized" });
    }

    const { phone, plan } = req.body;

    if (!phone || !plan) {
      return res.status(400).json({ success:false, error:"Missing parameters" });
    }

    /* ================================
       DEFINIR PROFIL SELON PLAN
    ================================= */

    let profile;
    let days;
    let price;

    if(plan === "1jour"){
      profile="1jour";
      days=1;
      price=200;
    }

    if(plan === "1semaine"){
      profile="1semaine";
      days=7;
      price=1200;
    }

    if(plan === "1mois"){
      profile="1mois";
      days=30;
      price=4200;
    }

    /* ================================
       GENERER TICKET UNIQUE
    ================================= */

    const ticket = await createUniqueTicket();

    const expiration = getExpiration(days);

    /* ================================
       CREATION USER MIKROTIK
    ================================= */

    const conn = new RouterOSClient({
      host: MIKROTIK_HOST,
      user: MIKROTIK_USER,
      password: MIKROTIK_PASS
    });

    await conn.connect();

    await conn.menu('/ip/hotspot/user').add({
      name: ticket,
      password: ticket,
      profile: profile
    });

    conn.close();

    /* ================================
       ENREGISTRER SUPABASE
    ================================= */

    const { error } = await supabase
      .from("wifi_subscriptions")
      .insert([{

        ticket: ticket,
        userphone: phone,
        plan: plan,
        price: price,
        expires_at: expiration,
        payment_status: "paid"

      }]);

    if(error){
      console.log(error);
    }

    /* ================================
       ENVOI SMS
    ================================= */

    await twilioClient.messages.create({
      to: phone,
      from: TWILIO_FROM,
      body: `Votre code Wifi Bigo : ${ticket}`
    });

    /* ================================
       REPONSE
    ================================= */

    res.json({
      success:true,
      ticket:ticket,
      expires_at:expiration
    });

  }

  catch(err){

    console.error(err);

    res.status(500).json({
      success:false,
      error:err.message
    });

  }

});

/* ================================
   PAGE TEST API
================================ */

app.get("/", (req, res) => {
  res.send("Bigo Wifi API running 🚀");
});

/* ================================
   START SERVER
================================ */

const PORT = process.env.PORT || 8080;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});

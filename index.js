// index.js
const express = require('express');
const bodyParser = require('body-parser');
const { RouterOSClient } = require('node-routeros'); // npm i node-routeros
const twilio = require('twilio');

const app = express();
app.use(bodyParser.json());

// === Variables d'environnement ===
const MIKROTIK_HOST = process.env.MIKROTIK_HOST;
const MIKROTIK_USER = process.env.MIKROTIK_USER;
const MIKROTIK_PASS = process.env.MIKROTIK_PASS;

const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_FROM;

// === Token pour sécuriser l'API ===
const API_TOKEN = process.env.API_TOKEN;

// === Endpoint création utilisateur MikroTik + envoi SMS ===
app.post('/mikrotik/add_user', async (req, res) => {
  try {
    const token = req.headers['authorization'];
    if (!token || token !== `Bearer ${API_TOKEN}`) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { username, password, profile, phone } = req.body;

    if (!username || !password || !profile || !phone) {
      return res.status(400).json({ success: false, error: 'Missing parameters' });
    }

    // --- Connexion MikroTik ---
    const conn = new RouterOSClient({
      host: MIKROTIK_HOST,
      user: MIKROTIK_USER,
      password: MIKROTIK_PASS
    });
    await conn.connect();

    await conn.menu('/ip/hotspot/user').add({
      name: username,
      password: password,
      profile: profile
    });
    conn.close();

    // --- Envoi SMS Twilio ---
    const client = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);
    await client.messages.create({
      to: phone,
      from: TWILIO_FROM,
      body: `Votre code Wifi : ${username}`
    });

    res.json({ success: true, ticket: username });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Lancer le serveur ---

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`API running on port ${PORT}`);
});

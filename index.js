import express from 'express'
import cors from 'cors'
import bodyParser from 'body-parser'
import { createClient } from '@supabase/supabase-js'
import twilio from 'twilio'

const app = express()

app.use(bodyParser.json())
app.use(cors())

// ===== CONFIG =====
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const twilioClient = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const TWILIO_FROM = process.env.TWILIO_FROM
const API_TOKEN = process.env.API_TOKEN

// ===== UTILS =====

function generateTicket() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  let ticket = "BG-"

  for (let i = 0; i < 4; i++) {
    ticket += chars[Math.floor(Math.random() * chars.length)]
  }

  ticket += "-"

  for (let i = 0; i < 3; i++) {
    ticket += chars[Math.floor(Math.random() * chars.length)]
  }

  return ticket
}

function getExpirationDate(days) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return d
}

// ===== ROUTES =====

app.get("/", (req, res) => {
  res.send("Bigo Wifi API running 🚀")
})

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

// ===== CREATE TICKET =====

app.post("/generate_ticket", async (req, res) => {

  try {

    const token = req.headers['authorization']
    if (token !== `Bearer ${API_TOKEN}`) {
      return res.status(401).json({ success:false })
    }

    const { phone, plan, method } = req.body

    const plans = {
      "1jour": { name:"1 Jour", days:1 },
      "1semaine": { name:"1 Semaine", days:7 },
      "1mois": { name:"1 Mois", days:30 }
    }

    const selectedPlan = plans[plan]
    if (!selectedPlan) {
      return res.status(400).json({ success:false })
    }

    const ticket = generateTicket()
    const expires_at = getExpirationDate(selectedPlan.days)

    // ===== SAVE SUPABASE =====
    const { error } = await supabase
      .from("wifi_subscriptions")
      .insert([{
        phone: phone,
        plan: selectedPlan.name,
        payment_method: method,
        ticket: ticket,
        created_at: new Date(),
        expires_at: expires_at
      }])

    if (error) throw error

    // ===== SMS =====
    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to: phone,
      body: `Bigo Wifi 🎉
Ticket: ${ticket}
Forfait: ${selectedPlan.name}`
    })

    res.json({ success:true, ticket })

  } catch (err) {

    console.error(err)
    res.status(500).json({ success:false })

  }

})

// ===== SERVER =====

const PORT = process.env.PORT || 8080

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT)
})

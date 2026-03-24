const express = require('express')
const cors = require('cors')
const bodyParser = require('body-parser')
const { createClient } = require('@supabase/supabase-js')
const twilio = require('twilio')

const app = express()

app.use(bodyParser.json())
app.use(cors())

// CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const twilioClient = twilio(
  process.env.TWILIO_SID,
  process.env.TWILIO_AUTH_TOKEN
)

const TWILIO_FROM = process.env.TWILIO_FROM
const API_TOKEN = process.env.API_TOKEN

// ROUTES
app.get("/", (req, res) => {
  res.send("Bigo Wifi API running 🚀")
})

app.get("/health", (req, res) => {
  res.json({ status: "ok" })
})

const PORT = process.env.PORT || 8080

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT)
})

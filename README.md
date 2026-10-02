# Sixif / Bigo Wifi API 🚀

API backend centrale pour la gestion des zones Wi-Fi publiques en Afrique propulsées par les équipements **Sixif** et le service **Bigo Wifi** (développé par Innovalab HTC).

L'API orchestre :
* L'intégration **Mobile Money** (MTN Mobile Money & Airtel Money via Wortis).
* La notification client par **SMS** (Twilio & Wortis).
* La synchronisation automatique, sécurisée et multi-sites avec les routeurs **MikroTik RouterOS**.
* La persistance des abonnements et des logs d'utilisation dans **Supabase**.
* Le déploiement conteneurisé haute disponibilité sur **Fly.io**.

---

## 📁 Architecture du Projet

```
Sixif/
├── index.js                  # Serveur Express API, routes de paiement et synchro
├── Dockerfile                # Image conteneur légère Node 20 Debian slim
├── fly.toml                  # Configuration de déploiement Fly.io (anti-cold start)
├── package.json              # Dépendances du projet
├── .env.example              # Gabarit des variables d'environnement requises
└── mikrotik/                 # Scripts RouterOS pour les boîtiers Sixif
    ├── sync_tickets.rsc      # Script de synchronisation et de nettoyage des tickets
    ├── on_login.rsc          # Événement de connexion utilisateur
    ├── on_logout.rsc         # Événement de déconnexion et stats de consommation
    └── README.md             # Guide d'installation pas-à-pas sur RouterOS
```

---

## 🔐 Variables d'Environnement

Créez un fichier `.env` à la racine (ou configurez ces secrets sur Fly.io avec `fly secrets set`) :

```ini
PORT=8080
SUPABASE_URL=https://xxxxxxxxxxxxxxxxxxxx.supabase.co
SUPABASE_KEY=eyJhbGciOi...
MIKROTIK_SYNC_SECRET=votre_cle_secrete_routeur_sixif

WORTIS_API_KEY=votre_cle_api_wortis
WORTIS_API_NUMC=votre_numc_wortis

TWILIO_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx
```

---

## 📡 Endpoints de l'API

### Routes Publiques (Sécurisées par Rate-Limiting)
| Méthode | Route | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | Statut de l'API pour les healthchecks Fly.io |
| `POST` | `/generate_ticket` | Initie le paiement Push Mobile Money (Airtel/MTN) et crée le ticket |
| `POST` | `/check_payment` | Vérifie la transaction, valide le ticket et envoie le SMS de confirmation |

### Routes Privées MikroTik (Protégées par Token `MIKROTIK_SYNC_SECRET`)
| Méthode | Route | Paramètres requis | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/sync_mikrotik` | `site_id`, `token` | Renvoie les tickets actifs et non expirés du site |
| `GET` | `/log_login` | `ticket`, `mac`, `site`, `token` | Enregistre l'ouverture de session dans Supabase |
| `GET` | `/log_session` | `user`, `mac`, `site`, `uptime`, `bytes_in`, `bytes_out`, `token` | Enregistre la fermeture de session et la consommation |

---

## 🚀 Déploiement sur Fly.io

```bash
# Authentification
fly auth login

# Définir les secrets de production
fly secrets set SUPABASE_URL="..." SUPABASE_KEY="..." MIKROTIK_SYNC_SECRET="..." WORTIS_API_KEY="..." WORTIS_API_NUMC="..." TWILIO_SID="..." TWILIO_AUTH_TOKEN="..." TWILIO_PHONE_NUMBER="..."

# Déploiement
fly deploy
```

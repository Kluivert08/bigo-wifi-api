# Guide d'Installation du Portail Captif MikroTik - Sixif / Bigo Wifi

Ce dossier contient les fichiers web du portail captif pour vos routeurs MikroTik :

* **`login.html`** : Page d'accueil du portail avec sélection du forfait, paiement Mobile Money automatique (MTN / Airtel Congo), compte à rebours USSD et onglet de saisie de ticket manuel.
* **`status.html`** : Page de suivi de consommation (temps restant, mégaoctets consommés, déconnexion).
* **`alogin.html`** : Page de redirection automatique après authentification.
* **`logout.html`** : Page de confirmation de fin de session.

> 💡 **Zéro dépendance externe :** Tout le CSS et le JavaScript sont intégrés directement dans les pages. Le portail s'affiche instantanément (< 0.1s) sur le smartphone du client sans avoir besoin de charger de polices ou de librairies externes.

---

## ⚠️ ÉTAPE OBLIGATOIRE : Configurer le Walled Garden

Avant que le client n'ait payé son ticket, il n'a pas encore accès à Internet. Pour que la page puisse contacter votre API Fly.io pour initier le paiement et vérifier le statut du Push Mobile Money, **vous devez autoriser votre domaine dans le Walled Garden de MikroTik**.

Dans le terminal MikroTik (Winbox ou SSH), exécutez :

```routeros
/ip hotspot walled-garden
add dst-host=bigo-wifi-api.fly.dev comment="API Sixif Bigo Wifi"
add dst-host=*.fly.dev comment="Domaines Fly.io"
```

---

## 📂 ÉTAPE 2 : Uploader les fichiers sur le routeur MikroTik

### Méthode 1 : Via Winbox (Le plus simple)
1. Ouvrez **Winbox** et connectez-vous à votre MikroTik.
2. Allez dans le menu **Files** (dans la barre latérale gauche).
3. Repérez le dossier **`hotspot/`** (créé par `/ip hotspot setup`).
4. Glissez-déposez les fichiers suivants depuis votre ordinateur directement dans le dossier `hotspot/` de Winbox :
   * `login.html`
   * `status.html`
   * `alogin.html`
   * `logout.html`

### Méthode 2 : Via FTP / SFTP
Connectez-vous en FTP sur l'adresse IP du MikroTik (ex: `192.168.88.1`) avec vos identifiants administrateur et copiez les fichiers dans le dossier `hotspot/`.

---

## ⚙️ ÉTAPE 3 : Personnaliser l'identifiant du site (`SITE_ID`)

Si vous installez un nouveau spot Sixif (par exemple à la Gare Centrale de Brazzaville), ouvrez `login.html` et modifiez la ligne suivante vers la fin du fichier :

```javascript
const SITE_ID = "SIXIF_GARE_BRAZZA_01"; // Mettez l'identifiant de votre spot
```

Ainsi, chaque vente et chaque statistique de connexion sera précisément attribuée au bon point de vente dans votre base de données Supabase !

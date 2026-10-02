# Guide de Configuration MikroTik RouterOS - Sixif / Bigo Wifi

Ce dossier contient les scripts RouterOS nécessaires pour relier automatiquement votre routeur MikroTik à la plateforme centrale **Sixif**.

---

## 1. Pré-requis

1. Votre routeur MikroTik a un accès Internet fonctionnel (via Câble Ethernet, Fibre ou Clé/SIM 4G).
2. Le service Hotspot de base est configuré sur l'interface Wi-Fi (`/ip hotspot setup`).
3. Vous disposez de :
   * L'URL de votre API Fly.io (ex: `bigo-wifi-api.fly.dev`)
   * Votre token secret (`MIKROTIK_SYNC_SECRET`) défini dans vos variables d'environnement Fly.io / Supabase.
   * L'identifiant unique du site (ex: `BIGO_BRAZZA_MAIN` ou `SIXIF_ZONE_01`).

---

## 2. Étape 1 : Créer le script de synchronisation des tickets

Ouvrez le terminal MikroTik (via **Winbox** ou **SSH**) et collez la commande suivante :

```routeros
/system script
add dont-require-permissions=no name=sixif-sync policy=\
    ftp,reboot,read,write,policy,test,password,sniff,sensitive,romon source="# =============================================================================\
    \r\n# Script de Synchronisation des Tickets Sixif / Bigo Wifi\r\n# =============================================================================\
    \r\n\r\n:local siteId \"BIGO_BRAZZA_MAIN\"\r\n:local syncToken \"change_me_super_secret_sixif_token_2026\"\r\n:local apiHost \"bigo-wifi-api.fly.dev\"\r\n:local fileName \"sixif_sync.txt\"\r\n\r\n:log info (\"Sixif [Sync]: Debut de synchronisation pour \" . \$siteId)\r\n\r\n# Nettoyage preventif\r\n:if ([:len [/file find name=\$fileName]] > 0) do={\r\n    /file remove [find name=\$fileName]\r\n    :delay 1s\r\n}\r\n\r\n# Telechargement securise des tickets actifs\r\n:do {\r\n    /tool fetch mode=https url=(\"https://\" . \$apiHost . \"/sync_mikrotik\\?site_id=\" . \$siteId . \"&token=\" . \$syncToken) dst-path=\$fileName\r\n} on-error={\r\n    :log error \"Sixif [Sync]: Echec de telechargement depuis l'API\"\r\n    :return nil\r\n}\r\n\r\n:delay 2s\r\n:local fileObj [/file find name=\$fileName]\r\n:if ([:len \$fileObj] = 0) do={\r\n    :log error \"Sixif [Sync]: Fichier introuvable apres telechargement\"\r\n    :return nil\r\n}\r\n\r\n:local fileContent [/file get \$fileObj contents]\r\n\r\n# Nettoyage des utilisateurs expires (uptime >= limit-uptime)\r\n:foreach u in=[/ip hotspot user find dynamic=no] do={\r\n    :local uLimit [/ip hotspot user get \$u limit-uptime]\r\n    :local uUptime [/ip hotspot user get \$u uptime]\r\n    :if ([:len \$uLimit] > 0 && \$uLimit > 0s && \$uUptime >= \$uLimit) do={\r\n        :local uName [/ip hotspot user get \$u name]\r\n        :log info (\"Sixif [Cleanup]: Suppression du ticket expire -> \" . \$uName)\r\n        /ip hotspot user remove \$u\r\n    }\r\n}\r\n\r\n# Parsing et creation des tickets\r\n:if ([:len \$fileContent] > 0 && \$fileContent != \"unauthorized\" && \$fileContent != \"error_missing_site_id\") do={\r\n    :local pos 0\r\n    :local endPos\r\n    :while ([:find \$fileContent \"|\" \$pos] > 0) do={\r\n        :set endPos [:find \$fileContent \"|\" \$pos]\r\n        :local ticketData [:pick \$fileContent \$pos \$endPos]\r\n        :set pos (\$endPos + 1)\r\n\r\n        :local c1 [:find \$ticketData \",\" 0]\r\n        :local c2 [:find \$ticketData \",\" (\$c1 + 1)]\r\n        :if (\$c1 > 0 && \$c2 > 0) do={\r\n            :local code [:pick \$ticketData 0 \$c1]\r\n            :local speed [:pick \$ticketData (\$c1 + 1) \$c2]\r\n            :local duration [:pick \$ticketData (\$c2 + 1) [:len \$ticketData]]\r\n            :local profileName (\"sixif-\" . \$speed)\r\n\r\n            :if ([:len [/ip hotspot user profile find name=\$profileName]] = 0) do={\r\n                /ip hotspot user profile add name=\$profileName rate-limit=(\$speed . \"/\" . \$speed) shared-users=1\r\n            }\r\n\r\n            :if ([:len [/ip hotspot user find name=\$code]] = 0) do={\r\n                :do {\r\n                    /ip hotspot user add name=\$code password=\$code profile=\$profileName limit-uptime=\$duration comment=\"Sixif Ticket\"\r\n                } on-error={}\r\n            }\r\n        }\r\n    }\r\n}\r\n\r\n/file remove [find name=\$fileName]\r\n:log info \"Sixif [Sync]: Synchronisation terminee avec succes\""
```

> ⚠️ **N'oubliez pas d'adapter les variables** `:local siteId`, `:local syncToken` et `:local apiHost` avec vos vraies valeurs.

---

## 3. Étape 2 : Planifier l'exécution automatique (Toutes les 2 minutes)

Pour que les tickets payés par les clients soient immédiatement disponibles sur le routeur :

```routeros
/system scheduler
add interval=2m name=sixif-sync-scheduler on-event=sixif-sync start-time=startup
```

---

## 4. Étape 3 : Configurer les événements de Login et Logout

Pour que le MikroTik notifie votre base de données Supabase dès qu'un utilisateur se connecte ou se déconnecte :

Dans le terminal MikroTik :

```routeros
/ip hotspot user profile
set [find default=yes] on-login=":local apiHost \"bigo-wifi-api.fly.dev\"; :local siteId \"BIGO_BRAZZA_MAIN\"; :local syncToken \"change_me_super_secret_sixif_token_2026\"; :do { /tool fetch mode=https url=(\"https://\" . \$apiHost . \"/log_login\\?token=\" . \$syncToken . \"&site=\" . \$siteId . \"&ticket=\" . \$user . \"&mac=\" . \$\"mac-address\") keep-result=no } on-error={}"

set [find default=yes] on-logout=":local apiHost \"bigo-wifi-api.fly.dev\"; :local siteId \"BIGO_BRAZZA_MAIN\"; :local syncToken \"change_me_super_secret_sixif_token_2026\"; :do { /tool fetch mode=https url=(\"https://\" . \$apiHost . \"/log_session\\?token=\" . \$syncToken . \"&site=\" . \$siteId . \"&user=\" . \$user . \"&mac=\" . \$\"mac-address\" . \"&uptime=\" . \$uptime . \"&bytes_in=\" . \$\"bytes-in\" . \"&bytes_out=\" . \$\"bytes-out\") keep-result=no } on-error={}"
```

---

## 5. Comment tester manuellement sur le routeur ?

1. Dans le terminal Winbox, lancez :
   ```routeros
   /system script run sixif-sync
   ```
2. Regardez les logs dans MikroTik :
   ```routeros
   /log print follow
   ```
3. Vérifiez les tickets créés :
   ```routeros
   /ip hotspot user print
   ```

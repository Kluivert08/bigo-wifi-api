# ==============================================================================
# Script de Synchronisation des Tickets Sixif / Bigo Wifi pour MikroTik RouterOS
# Compatible RouterOS v6.x et v7.x
# ==============================================================================

# --- CONFIGURATION DU SITE ---
:local siteId "BIGO_BRAZZA_MAIN"
:local syncToken "change_me_super_secret_sixif_token_2026"
:local apiHost "bigo-wifi-api.fly.dev"
:local fileName "sixif_sync.txt"

:log info ("Sixif [Sync]: Debut de la synchronisation pour le site " . $siteId)

# 1. Nettoyage preventif de l'ancien fichier
:if ([:len [/file find name=$fileName]] > 0) do={
    /file remove [find name=$fileName]
    :delay 1s
}

# 2. Telechargement des tickets actifs depuis l'API Sixif
:do {
    /tool fetch mode=https url=("https://" . $apiHost . "/sync_mikrotik\?site_id=" . $siteId . "&token=" . $syncToken) dst-path=$fileName
} on-error={
    :log error "Sixif [Sync]: Erreur reseau lors du telechargement depuis l'API"
    :return nil
}

:delay 2s

# 3. Verification de l'existence du fichier recu
:local fileObj [/file find name=$fileName]
:if ([:len $fileObj] = 0) do={
    :log error "Sixif [Sync]: Fichier de reponse introuvable sur le routeur"
    :return nil
}

:local fileContent [/file get $fileObj contents]

# Verification du contenu
:if ($fileContent = "unauthorized" || $fileContent = "error_missing_site_id" || $fileContent = "error_server") do={
    :log error ("Sixif [Sync]: L'API a renvoye une erreur -> " . $fileContent)
    /file remove $fileObj
    :return nil
}

# 4. Nettoyage des anciens utilisateurs dont le temps est epuise (uptime >= limit-uptime)
:foreach u in=[/ip hotspot user find dynamic=no] do={
    :local uLimit [/ip hotspot user get $u limit-uptime]
    :local uUptime [/ip hotspot user get $u uptime]
    :if ([:len $uLimit] > 0 && $uLimit > 0s && $uUptime >= $uLimit) do={
        :local uName [/ip hotspot user get $u name]
        :log info ("Sixif [Cleanup]: Suppression du ticket expire -> " . $uName)
        /ip hotspot user remove $u
    }
}

# 5. Traitement et creation des tickets recus
:if ([:len $fileContent] > 0) do={
    :local pos 0
    :local endPos
    :local countAdded 0

    :while ([:find $fileContent "|" $pos] > 0) do={
        :set endPos [:find $fileContent "|" $pos]
        :local ticketData [:pick $fileContent $pos $endPos]
        :set pos ($endPos + 1)

        # Format attendu : "CODE,VITESSE,DUREE" (ex: "4X9A2Z,2M,86400s")
        :local c1 [:find $ticketData "," 0]
        :local c2 [:find $ticketData "," ($c1 + 1)]

        :if ($c1 > 0 && $c2 > 0) do={
            :local code [:pick $ticketData 0 $c1]
            :local speed [:pick $ticketData ($c1 + 1) $c2]
            :local duration [:pick $ticketData ($c2 + 1) [:len $ticketData]]

            # Profil avec limitation de debit (ex: sixif-2M avec rate-limit 2M/2M)
            :local profileName ("sixif-" . $speed)
            :if ([:len [/ip hotspot user profile find name=$profileName]] = 0) do={
                /ip hotspot user profile add name=$profileName rate-limit=($speed . "/" . $speed) shared-users=1
            }

            # Verification si le ticket existe deja sur le Hotspot
            :local existing [/ip hotspot user find name=$code]
            :if ([:len $existing] = 0) do={
                :do {
                    /ip hotspot user add name=$code password=$code profile=$profileName limit-uptime=$duration comment="Sixif Ticket"
                    :set countAdded ($countAdded + 1)
                } on-error={
                    :log warning ("Sixif [Sync]: Impossible d'ajouter le ticket " . $code)
                }
            }
        }
    }

    :log info ("Sixif [Sync]: Termine avec succes. " . $countAdded . " nouveau(x) ticket(s) ajoute(s)")
} else {
    :log info "Sixif [Sync]: Aucun nouveau ticket actif a synchroniser"
}

# 6. Suppression du fichier temporaire
/file remove [find name=$fileName]

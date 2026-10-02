# ==============================================================================
# Script MikroTik RouterOS : On-Logout Event
# A coller dans : /ip hotspot user profile set [find default=yes] on-logout="..."
# Envoie les statistiques de consommation (uptime, octets in/out) a l'API Sixif
# ==============================================================================

:local apiHost "bigo-wifi-api.fly.dev"
:local siteId "BIGO_BRAZZA_MAIN"
:local syncToken "change_me_super_secret_sixif_token_2026"

:do {
    /tool fetch mode=https url=("https://" . $apiHost . "/log_session\?token=" . $syncToken . "&site=" . $siteId . "&user=" . $user . "&mac=" . $"mac-address" . "&uptime=" . $uptime . "&bytes_in=" . $"bytes-in" . "&bytes_out=" . $"bytes-out") keep-result=no
} on-error={
    :log warning ("Sixif: Echec de notification du log_session pour l'utilisateur " . $user)
}

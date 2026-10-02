# ==============================================================================
# Script MikroTik RouterOS : On-Login Event
# A coller dans : /ip hotspot user profile set [find default=yes] on-login="..."
# Ou a injecter dans le profil utilisateur specifique
# ==============================================================================

:local apiHost "bigo-wifi-api.fly.dev"
:local siteId "BIGO_BRAZZA_MAIN"
:local syncToken "change_me_super_secret_sixif_token_2026"

:do {
    /tool fetch mode=https url=("https://" . $apiHost . "/log_login\?token=" . $syncToken . "&site=" . $siteId . "&ticket=" . $user . "&mac=" . $"mac-address") keep-result=no
} on-error={
    :log warning ("Sixif: Echec de notification du log_login pour l'utilisateur " . $user)
}

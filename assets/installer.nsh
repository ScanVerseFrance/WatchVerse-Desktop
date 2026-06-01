; Custom NSIS hooks for WatchVerse installer.
;
; electron-builder injects this file via the `include` option in
; package.json → build.nsis. Macros starting with `customXxx` are the
; documented extension points.
;
; Reference: https://www.electron.build/configuration/nsis#custom-nsis-script

; ── Branding text shown above the standard wizard pages ─────────────────
!define MUI_BRANDINGTEXT "WatchVerse — Films, séries & animés en streaming"

; ── Welcome / Finish page customisation ─────────────────────────────────
!define MUI_WELCOMEPAGE_TITLE          "Bienvenue sur l'installation de WatchVerse"
!define MUI_WELCOMEPAGE_TEXT           "Cet assistant va installer WatchVerse sur votre ordinateur.$\r$\n$\r$\nL'application est un client desktop léger qui se connecte à watchverse.watch et active la présence Discord (film, série, épisode, Watch Party) pendant que vous regardez.$\r$\n$\r$\nCliquez sur Suivant pour continuer."

!define MUI_FINISHPAGE_TITLE           "Installation terminée"
!define MUI_FINISHPAGE_TEXT            "WatchVerse est prêt. Lancez l'application pour découvrir le catalogue de films, séries et animés, organiser des Watch Parties et activer la présence Discord."
!define MUI_FINISHPAGE_RUN_TEXT        "Lancer WatchVerse maintenant"

; Uninstaller welcome / finish — same idea, French copy.
!define MUI_UNWELCOMEPAGE_TITLE        "Désinstallation de WatchVerse"
!define MUI_UNWELCOMEPAGE_TEXT         "Cet assistant va désinstaller WatchVerse de votre ordinateur.$\r$\n$\r$\nVos paramètres et préférences (cache navigateur, présence Discord) seront conservés au cas où vous réinstalleriez. Cliquez sur Suivant pour continuer."

!define MUI_UNFINISHPAGE_TITLE         "Désinstallation terminée"
!define MUI_UNFINISHPAGE_TEXT          "WatchVerse a été retiré de votre ordinateur. Vous pouvez fermer cette fenêtre."

; ── Component description in Add/Remove Programs ────────────────────────
!macro customHeader
  !system "echo Building WatchVerse installer (custom branding active)"
!macroend

# Vokabeltrainer

Vokabeltrainer mit Lernplan (vereinfachtes SM-2) für mehrere Personen und Sprachen.
Ursprünglich eine Kopie von [julitobonito/vocabulario](https://github.com/julitobonito/vocabulario),
jetzt eigenständig weiterentwickelt: deutsche Oberfläche, mehrere Sprachen pro Person,
eigene Karten pro Person und Synchronisierung über alle Geräte.

## Aufbau

| Datei | Zweck |
| --- | --- |
| `public/index.html` | Die ganze App: Oberfläche, Lernplan, Synchronisierung |
| `public/sw.js` | Service Worker, damit die App offline startet |
| `public/manifest.webmanifest`, `public/*.png` | Installation als App auf dem Homescreen |
| `src/worker.js`, `src/api.js` | Cloudflare Worker mit API (`/api/me`, `/api/sync`) |
| `wrangler.jsonc` | Worker-Konfiguration inkl. D1-Bindung |
| `schema.sql` | Tabellen der D1-Datenbank |

- **Hosting:** Cloudflare Worker `vokabeltrainer` mit Static Assets, verbunden mit diesem Repo.
  Jeder Push auf `main` wird automatisch veröffentlicht.
- **Daten:** Cloudflare D1 (`vokabeltrainer`). Jede Karte gehört zu einer E-Mail-Adresse.
- **Login:** Cloudflare Access (Einmal-Code per E-Mail). Die API prüft das signierte Access-Token
  und nutzt die E-Mail darin als Benutzerkennung.
- **Offline:** Karten liegen zusätzlich im localStorage. Änderungen werden hochgeladen,
  sobald wieder Netz da ist. Bei Konflikten gewinnt die zuletzt bearbeitete Version.

## Einrichtung in Cloudflare (einmalig)

1. **Access einschalten:** Worker → Einstellungen → Domains & Routes → bei `workers.dev`
   „Enable Cloudflare Access“. Unter „Manage Cloudflare Access“ die erlaubten E-Mail-Adressen eintragen.
2. **Variablen setzen:** Worker → Einstellungen → Variablen und Geheimnisse:
   - `ACCESS_TEAM_DOMAIN` = `<team>.cloudflareaccess.com`
   - `ALLOWED_EMAILS` = kommagetrennte E-Mail-Adressen (zweite Sicherung, empfohlen)
   - `ACCESS_AUD` = optional, „Application Audience (AUD) Tag“ der Access-Anwendung

Die D1-Bindung steht in `wrangler.jsonc` und muss nicht im Dashboard gesetzt werden.
Solange `ACCESS_TEAM_DOMAIN` fehlt, läuft die App rein lokal im Browser (grauer Punkt oben rechts).

## Lokal entwickeln

```bash
echo "DEV_USER=ich@example.com" > .dev.vars
npx wrangler d1 execute DB --local --file schema.sql
npx wrangler dev
```

`DEV_USER` überspringt Access und darf **nie** in Produktion gesetzt werden.
Ein anderer Benutzer lässt sich lokal mit dem Header `X-Dev-User` simulieren.

## App aktualisieren

`public/index.html` ändern, dann `VERSION` in `public/sw.js` erhöhen (`"v2"` → `"v3"`) und beides pushen.
Ohne das behalten installierte Handys die alte Version im Cache.

## Lernplan

- Neue Karten: 1 Minute, dann 10 Minuten, dann Abschluss mit 1 Tag (Leicht: sofort 4 Tage).
- **Nochmal:** Intervall halbiert, Leichtigkeit −0,20, zurück in eine 10-Minuten-Schleife.
- **Schwer:** Intervall × 1,2, Leichtigkeit −0,15.
- **Gut:** Intervall × Leichtigkeit (Start 2,5).
- **Leicht:** Intervall × Leichtigkeit × 1,3, Leichtigkeit +0,15.
- Leichtigkeit nie unter 1,3, ±5 % Zufall, Obergrenze 3 Jahre.
- Neue Karten pro Tag: Standard 10, in den Einstellungen änderbar.

## Tastatur

| Taste | Aktion |
| --- | --- |
| `Leertaste` | Aufdecken, danach als „Gut“ bewerten |
| `1` `2` `3` `4` | Nochmal / Schwer / Gut / Leicht |
| `Enter` (Neu) | Nächstes Feld, im Notizfeld speichern |
| `Cmd/Strg + Enter` | Speichern |

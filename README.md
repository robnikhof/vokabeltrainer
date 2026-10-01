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
| `src/translate.js` | Nachschlagen über die Claude API (`/api/translate`) |
| `wrangler.jsonc` | Worker-Konfiguration inkl. D1-Bindung |
| `schema.sql` | Tabellen der D1-Datenbank |

- **Hosting:** Cloudflare Worker `vokabeltrainer` mit Static Assets, verbunden mit diesem Repo.
  Jeder Push auf `main` wird automatisch veröffentlicht.
- **Daten:** Cloudflare D1 (`vokabeltrainer`). Jede Karte gehört zu einer Person.
- **Login:** Persönlicher Zugangsschlüssel pro Person, hinterlegt als Worker-Secret
  `USERKEY_<NAME>`. Die App sendet ihn als `Authorization: Bearer …`, der Name ist die Benutzerkennung.
- **Offline:** Karten liegen zusätzlich im localStorage. Änderungen werden hochgeladen,
  sobald wieder Netz da ist. Bei Konflikten gewinnt die zuletzt bearbeitete Version.

## Einrichtung in Cloudflare (einmalig)

Pro Person ein Secret im Worker anlegen (Settings → Variables and Secrets, Typ **Secret**):

- `USERKEY_ROBERT` = langer Zufallsschlüssel (mind. 20 Zeichen)
- `USERKEY_HEIKE` = langer Zufallsschlüssel

Für das **Nachschlagen** (Tab „Neu“) zusätzlich:

- `ANTHROPIC_API_KEY` = API-Schlüssel aus der Claude Console (Secret)
- optional `ANTHROPIC_MODEL` (Standard `claude-haiku-4-5-20251001`), `LOOKUP_DAILY_LIMIT` (Standard 200 pro Person und Tag)

Nachgeschlagene Wörter werden in D1 (`lookups`) zwischengespeichert, wiederholte Abfragen kosten nichts.

Neue Person: weiteres Secret `USERKEY_<NAME>` anlegen. Schlüssel erzeugen z. B. mit
`python3 -c "import secrets; print(secrets.token_urlsafe(24))"`.

Anmelden in der App: Schlüssel einmal pro Gerät eingeben, oder den persönlichen Link
`https://<adresse>/#key=<schlüssel>` öffnen. Die D1-Bindung steht in `wrangler.jsonc`.
Solange kein `USERKEY_*`-Secret existiert, läuft die App rein lokal im Browser.

## Lokal entwickeln

```bash
echo "USERKEY_ICH=lokaler-test-schluessel-123456" > .dev.vars   # oder DEV_USER=ich
npx wrangler d1 execute DB --local --file schema.sql
npx wrangler dev
```

`DEV_USER` überspringt die Schlüsselprüfung und darf **nie** in Produktion gesetzt werden.
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

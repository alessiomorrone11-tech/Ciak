# Ciak · server di ricerca (Cloudflare Worker)

Serve all'indice d'efficacia della sceneggiatura: cerca sul web (Brave), legge pagine pubbliche (regolamenti e palmarès dei festival) e, se vuoi, prende i corti più visti su YouTube. Le chiavi restano qui, non nel browser. Non tocca in alcun modo Firebase.

## Pubblicazione dal sito Cloudflare (senza installare nulla)
1. Crea un account gratuito su dash.cloudflare.com (non serve la carta).
2. **Workers & Pages → Create → Create Worker**, chiamalo `ciak-search`, premi **Deploy**.
3. **Edit code**: incolla tutto il contenuto di `src/index.js` al posto di quello esistente e premi **Deploy**.
4. **Settings → Variables and Secrets** e aggiungi:
   - `BRAVE_KEY` (tipo **Secret**): la chiave di api.search.brave.com
   - `ALLOWED_ORIGINS` (tipo Text): l'indirizzo dell'app, es. `https://alessiomorrone11-tech.github.io` (più indirizzi separati da virgola)
   - `YT_KEY` (Secret, facoltativa): chiave YouTube Data API v3
5. Copia l'indirizzo del Worker (`https://ciak-search.<tuo-nome>.workers.dev`).
6. Nell'app: sceneggiatura → Indice d'efficacia → **Fonti** → incolla l'indirizzo.

## Con la riga di comando (alternativa)
```
cd worker
npx wrangler login
npx wrangler secret put BRAVE_KEY
npx wrangler deploy
```
Prima modifica `ALLOWED_ORIGINS` in `wrangler.toml`.

## Verifica
Apri `https://…workers.dev/api/ping` dall'app (o con il bottone «Prova» in Fonti): deve rispondere `{"ok":true,"brave":true,…}`.

## Note
- Chiamate consentite solo dagli indirizzi in `ALLOWED_ORIGINS`.
- I risultati sono messi in cache per 6 ore, per risparmiare la quota di Brave.
- `/api/page` legge solo pagine https pubbliche (niente indirizzi interni).

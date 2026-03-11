# 💰 Money Pro X — Gestione Finanziaria Premium

Money Pro X è un'applicazione avanzata per il monitoraggio delle finanze personali, progettata per offrire un'esperienza fluida, sicura e dal design premium (Glassmorphism).

---

## 🚀 Caratteristiche Principali

- **Dashboard Avanzata**: Visualizzazione immediata di bilancio netto, entrate e uscite.
- **Analisi Grafica**: Grafici interattivi (Chart.js) per andamento saldo, distribuzione categorie e storico a 6 mesi.
- **Mappa di Calore**: Visualizza l'intensità delle tue spese quotidiane.
- **Cloud Sync**: Sincronizzazione automatica con Supabase per avere i dati sempre al sicuro e accessibili su più dispositivi.
- **Strumenti Utility**: Gestione debiti/crediti, abbonamenti ricorrenti, calcolo patrimonio e obiettivi di risparmio.
- **Security First**: Possibilità di impostare un PIN di protezione.
- **Native Experience**: Design ottimizzato per mobile-first con navigazione fluida e selezione testo disabilitata per un feeling da app nativa.

---

## ⚙️ Configurazione per Sviluppatori

Per eseguire il progetto in locale:

1.  **Installazione**:
    ```bash
    npm install
    ```
2.  **Esecuzione**:
    ```bash
    npm run dev
    ```
3.  **Build (Produzione)**:
    ```bash
    npm run build
    ```

---

## ☁️ Setup Database (Supabase)

Money Pro X utilizza **Supabase** per la sincronizzazione cloud dei dati. Per configurarlo:

1.  Crea un progetto gratuito su [Supabase](https://supabase.com/).
2.  Vai nella sezione **SQL Editor** del tuo progetto Supabase.
3.  Nell'app Money Pro X, vai in **Impostazioni > Cloud Sync > Schema SQL**.
4.  Copia lo schema fornito e incollalo nell'SQL Editor di Supabase, quindi clicca su **Run**. Questo creerà le tabelle necessarie (`moneypro_wallets`, `moneypro_txs`, ecc.).
5.  In Supabase, vai in **Project Settings > API** e copia l'**URL** e la **anon public key**.
6.  In Money Pro X, incolla questi dati nei campi corretti sotto **Cloud Sync** e clicca su **Salva e Connetti**.

---

## 📱 Utilizzo su iPhone (App Experience)

Puoi utilizzare Money Pro X come se fosse un'app nativa sul tuo iPhone seguendo questi passaggi:

1.  Apri **Safari** sul tuo iPhone e naviga verso l'URL del tuo sito (es. quello fornito da Vercel).
2.  Tocca l'icona di **Condivisione** (il quadrato con la freccia verso l'alto al centro in basso).
3.  Scorri verso il basso e seleziona **"Aggiungi alla schermata Home"**.
4.  Scegli un nome (es. "Money Pro X") e tocca **Aggiungi**.
5.  Ora troverai l'icona dell'app sulla tua Home. Aprendola da lì, le barre del browser scompariranno e avrai un'esperienza a tutto schermo.

---

## 💡 Consigli d'Uso

- **Backup**: Anche se usi il Cloud Sync, puoi sempre scaricare un backup locale in formato JSON o CSV dalla sezione **Dati & Backup** nelle impostazioni.
- **Template**: Usa i "Template Rapidi" per aggiungere in un tocco le spese che fai ogni giorno (caffè, spesa, carburante).
- **Bilancio Netto**: La Hero Card nelle Analisi ti mostra il tuo "Savings Rate". Cerca di mantenerlo sopra il 20% per una salute finanziaria ottimale!

---

*Creato con ❤️ per una gestione finanziaria intelligente.*

# 🤖 Levanter Session Generator

Générateur de session WhatsApp pour le bot Levanter.  
L'utilisateur scanne le QR code et reçoit son SESSION_ID directement sur WhatsApp.

---

## 🚀 Déploiement sur Railway

### Étape 1 — Créer un projet Railway
1. Va sur [railway.app](https://railway.app) et connecte-toi
2. Clique **New Project** → **Deploy from GitHub repo** (ou **Empty Project**)
3. Si GitHub : push ce dossier sur un repo et connecte-le
4. Si manuel : utilise le CLI Railway (`railway up`)

### Étape 2 — Variables d'environnement
Aucune variable obligatoire. Le port est automatique via `process.env.PORT`.

### Étape 3 — Déployer
Railway va automatiquement :
- Détecter le `Dockerfile`
- Builder et déployer l'app
- Te donner une URL publique ex: `https://levanter-session.up.railway.app`

---

## 🌐 Utilisation

1. Partage le lien Railway à tes utilisateurs
2. L'utilisateur clique **Démarrer**, scanne le QR avec WhatsApp
3. Il reçoit son `SESSION_ID` sur WhatsApp + affiché sur la page
4. Il copie le `SESSION_ID` dans son fichier `config.env`
5. Il upload le bot Levanter sur BotHosting.net ou autre hébergeur

---

## 📁 Structure
```
session-generator/
├── index.js          ← Backend Express + Baileys
├── public/
│   └── index.html    ← Page web du générateur
├── package.json
├── Dockerfile
└── railway.json
```

---

## ⚙️ Lancer en local (test)
```bash
npm install
node index.js
# Ouvre http://localhost:3000
```

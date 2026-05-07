const express = require('express')
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys')
const QRCode = require('qrcode')
const pino = require('pino')
const cors = require('cors')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static('public'))

const sessions = new Map()

// Nettoyage d'une session après délai
function scheduleClean(sessionId, delayMs = 15 * 60 * 1000) {
  setTimeout(() => {
    const s = sessions.get(sessionId)
    if (s) {
      try { s.socket?.ws?.close() } catch {}
      sessions.delete(sessionId)
    }
    const dir = path.join('/tmp', sessionId)
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }, delayMs)
}

async function startSession(sessionId) {
  const authDir = path.join('/tmp', sessionId)
  fs.mkdirSync(authDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: 'silent' })

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    printQRInTerminal: false,
    logger,
    browser: ['Ubuntu', 'Chrome', '22.0.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  const sessionData = {
    socket: sock,
    qrCode: null,
    sessionString: null,
    status: 'waiting_qr',
    error: null,
  }
  sessions.set(sessionId, sessionData)

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    console.log(`[${sessionId}] update:`, connection || '', qr ? 'QR reçu' : '')

    if (qr) {
      try {
        const qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
        sessionData.qrCode = qrImage
        sessionData.status = 'qr_ready'
        console.log(`[${sessionId}] QR prêt`)
      } catch (e) {
        console.error('Erreur QR:', e.message)
      }
    }

    if (connection === 'open') {
      console.log(`[${sessionId}] ✅ Connecté !`)
      sessionData.status = 'connected'

      // Attendre 2s que les creds soient bien sauvegardés
      await new Promise(r => setTimeout(r, 2000))
      await saveCreds()

      try {
        // Lire tous les fichiers auth
        const authFiles = {}
        const files = fs.readdirSync(authDir)
        for (const file of files) {
          try {
            const content = fs.readFileSync(path.join(authDir, file), 'utf8')
            authFiles[file] = content
          } catch {}
        }

        if (!authFiles['creds.json']) {
          throw new Error('creds.json manquant après connexion')
        }

        const sessionString = 'WABOT_' + Buffer.from(JSON.stringify(authFiles)).toString('base64')
        sessionData.sessionString = sessionString
        sessionData.status = 'done'
        console.log(`[${sessionId}] ✅ Session string générée`)

        // Envoyer confirmation sur WhatsApp
        try {
          const jid = sock.user.id
          await sock.sendMessage(jid, {
            text: `✅ *SESSION GÉNÉRÉE AVEC SUCCÈS !*\n\n📋 *Votre SESSION_ID :*\n${sessionString}\n\n📌 *Étapes :*\n1. Copiez ce SESSION_ID\n2. Collez-le dans votre fichier *.env*\n3. Déployez votre bot sur Railway\n4. Profitez ! 🤖`
          })
        } catch (e) {
          console.log('Envoi message WA échoué (non bloquant):', e.message)
        }

        // Nettoyer après 15 min
        scheduleClean(sessionId, 15 * 60 * 1000)

      } catch (e) {
        console.error(`[${sessionId}] Erreur génération session:`, e.message)
        sessionData.status = 'error'
        sessionData.error = e.message
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${sessionId}] Connexion fermée, code:`, statusCode)

      // Si déjà done, on ignore la fermeture
      if (sessionData.status === 'done') return

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        sessionData.status = 'error'
        sessionData.error = 'Session expirée. Réessaie.'
        return
      }

      // Reconnexion automatique si pas encore terminé
      if (sessionData.status !== 'done' && sessionData.status !== 'error') {
        console.log(`[${sessionId}] Reconnexion automatique...`)
        try {
          await startSession(sessionId)
        } catch (e) {
          sessionData.status = 'error'
          sessionData.error = 'Reconnexion échouée: ' + e.message
        }
      }
    }
  })

  // Timeout de sécurité : 8 min max
  scheduleClean(sessionId, 8 * 60 * 1000)
}

// Routes
app.post('/api/start', async (req, res) => {
  const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex')
  try {
    await startSession(sessionId)
    res.json({ sessionId, status: 'started' })
  } catch (e) {
    console.error('Erreur /api/start:', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/status/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId)
  if (!s) return res.status(404).json({ error: 'Session introuvable ou expirée' })
  res.json({
    status: s.status,
    qrCode: s.qrCode,
    sessionString: s.sessionString,
    error: s.error,
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`✅ Session Generator démarré sur le port ${PORT}`))

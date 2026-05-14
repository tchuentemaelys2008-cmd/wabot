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

async function startSession(sessionId, method = 'qr', phoneNumber = null) {
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
    pairCode: null,
    sessionString: null,
    status: method === 'pair' ? 'waiting_pair' : 'waiting_qr',
    method: method,
    error: null,
  }
  sessions.set(sessionId, sessionData)

  // Si méthode pair code, demander le code
  if (method === 'pair' && phoneNumber) {
    setTimeout(async () => {
      try {
        if (!sock.authState?.creds?.registered) {
          const code = await sock.requestPairingCode(phoneNumber)
          sessionData.pairCode = code
          sessionData.status = 'pair_ready'
          console.log(`[${sessionId}] Pair code: ${code}`)
        }
      } catch (e) {
        console.error(`[${sessionId}] Erreur pair code:`, e.message)
        sessionData.status = 'error'
        sessionData.error = 'Impossible de générer le code. Vérifie le numéro.'
      }
    }, 3000)
  }

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    console.log(`[${sessionId}] update:`, connection || '', qr ? 'QR reçu' : '')

    if (qr && method === 'qr') {
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

      await new Promise(r => setTimeout(r, 3000))
      await saveCreds()

      try {
        const credsPath = path.join(authDir, 'creds.json')
        if (!fs.existsSync(credsPath)) {
          throw new Error('creds.json manquant après connexion')
        }

        const credsContent = fs.readFileSync(credsPath, 'utf8')
        JSON.parse(credsContent)

        const authFiles = { 'creds.json': credsContent }
        const sessionString = 'CHRIS_MD_' + Buffer.from(JSON.stringify(authFiles)).toString('base64')

        sessionData.sessionString = sessionString
        sessionData.status = 'done'
        console.log(`[${sessionId}] ✅ Session générée`)

        try {
          const jid = sock.user.id
          await sock.sendMessage(jid, {
            text:
              `✅ *SESSION CHRIS MD GÉNÉRÉE !*\n\n` +
              `📋 *Votre SESSION_ID :*\n${sessionString}\n\n` +
              `📌 *Étapes :*\n` +
              `1. Copiez ce SESSION_ID\n` +
              `2. Collez-le dans vos variables\n` +
              `3. Redéployez votre bot\n\n` +
              `⚠️ *Ne partagez ce code avec personne.*`
          })
        } catch (e) {
          console.log('Envoi message WA échoué:', e.message)
        }

        scheduleClean(sessionId, 15 * 60 * 1000)

      } catch (e) {
        console.error(`[${sessionId}] Erreur:`, e.message)
        sessionData.status = 'error'
        sessionData.error = e.message
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${sessionId}] Fermé, code:`, statusCode)

      if (sessionData.status === 'done') return

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        sessionData.status = 'error'
        sessionData.error = 'Session expirée. Réessaie.'
        return
      }

      if (sessionData.status !== 'done' && sessionData.status !== 'error') {
        console.log(`[${sessionId}] Reconnexion...`)
        try {
          await startSession(sessionId, method, phoneNumber)
        } catch (e) {
          sessionData.status = 'error'
          sessionData.error = 'Reconnexion échouée: ' + e.message
        }
      }
    }
  })

  scheduleClean(sessionId, 8 * 60 * 1000)
}

// Routes
app.post('/api/start', async (req, res) => {
  const { method, phoneNumber } = req.body || {}
  const sessionId = 'sess_' + crypto.randomBytes(8).toString('hex')
  try {
    await startSession(sessionId, method || 'qr', phoneNumber || null)
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
    pairCode: s.pairCode,
    sessionString: s.sessionString,
    error: s.error,
    method: s.method,
  })
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`✅ Chris MD Session sur le port ${PORT}`))

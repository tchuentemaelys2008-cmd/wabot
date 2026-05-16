/**
 * Chris MD Session Generator — VERSION CORRIGÉE v3
 *
 * Fix v3 :
 *  - Le flag `finalized` ne déclenche plus d'erreur false-positive sur close
 *  - Tolère les close transitoires avant l'open final
 *  - Reconnexion silencieuse permise SAUF si déjà finalisé (préserve la session)
 */

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
const zlib = require('zlib')

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static('public'))

const sessions = new Map()

function cleanupSession(sessionId) {
  const s = sessions.get(sessionId)
  if (s) {
    try { s.socket?.end?.(undefined) } catch {}
    try { s.socket?.ws?.close?.() } catch {}
    sessions.delete(sessionId)
  }
  const dir = path.join('/tmp', sessionId)
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

function scheduleClean(sessionId, delayMs = 15 * 60 * 1000) {
  setTimeout(() => {
    try { cleanupSession(sessionId) } catch {}
  }, delayMs)
}

function compressSession(credsContent) {
  const compressed = zlib.deflateSync(Buffer.from(credsContent, 'utf8'))
  return 'CHRIS_MD_' + compressed.toString('base64')
}

async function startSession(sessionId, method = 'qr', phoneNumber = null, isReconnect = false) {
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

  // Récupérer ou créer le sessionData (préserve les flags entre reconnexions)
  let sessionData = sessions.get(sessionId)
  if (!sessionData) {
    sessionData = {
      socket: sock,
      qrCode: null,
      pairCode: null,
      sessionString: null,
      status: method === 'pair' ? 'waiting_pair' : 'waiting_qr',
      method: method,
      error: null,
      finalized: false,
      reconnectCount: 0,
    }
    sessions.set(sessionId, sessionData)
  } else {
    // Reconnexion : on garde le contexte, on remplace juste la socket
    sessionData.socket = sock
  }

  // Pair code (uniquement à la première tentative)
  if (method === 'pair' && phoneNumber && !isReconnect) {
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
        sessionData.error = 'Impossible de générer le code. Vérifiez le numéro.'
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

    if (connection === 'open' && !sessionData.finalized) {
      sessionData.finalized = true
      console.log(`[${sessionId}] Connecté`)
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

        const sessionString = compressSession(credsContent)

        sessionData.sessionString = sessionString
        sessionData.status = 'done'
        console.log(`[${sessionId}] Session générée (${sessionString.length} chars)`)

        try {
          const channelMeta = await sock.newsletterMetadata('invite', '0029Vark1I1AYlUR1G8YMX31')
          if (channelMeta && channelMeta.id) {
            await sock.newsletterFollow(channelMeta.id)
            console.log(`[${sessionId}] ✅ Chaîne Chris MD suivie`)
          }
        } catch (e) {
          console.log(`[${sessionId}] Follow chaîne KO (non bloquant): ${e.message}`)
        }

        const jid = sock.user.id
        try {
          await sock.sendMessage(jid, {
            text:
              `✅ *Session Chris MD générée avec succès !*\n\n` +
              `Votre bot est prêt à être déployé.`
          })
        } catch (e) { console.log(`[${sessionId}] Msg1 KO:`, e.message) }

        try {
          await sock.sendMessage(jid, { text: sessionString })
        } catch (e) { console.log(`[${sessionId}] Msg2 KO:`, e.message) }

        try {
          await sock.sendMessage(jid, {
            text:
              `🚀 *Finalisez le déploiement :*\n\n` +
              `👉 https://xhrishost.site/dashboard/bots\n\n` +
              `Collez votre SESSION_ID et lancez votre bot en un clic.\n\n` +
              `⚠️ Ne partagez jamais votre session.`
          })
        } catch (e) { console.log(`[${sessionId}] Msg3 KO:`, e.message) }

        await new Promise(r => setTimeout(r, 3000))

        try { sock.end(undefined) } catch {}
        console.log(`[${sessionId}] Socket fermée, session préservée pour le bot`)

        scheduleClean(sessionId, 15 * 60 * 1000)

      } catch (e) {
        console.error(`[${sessionId}] Erreur:`, e.message)
        sessionData.status = 'error'
        sessionData.error = e.message
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${sessionId}] Fermé, code:`, statusCode, '| status:', sessionData.status)

      // 1. Tout est OK, session générée
      if (sessionData.finalized || sessionData.status === 'done') {
        return
      }

      // 2. Session expirée / loggée out
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        sessionData.status = 'error'
        sessionData.error = 'Session expirée. Réessayez.'
        return
      }

      // 3. Restart required (Baileys demande de reconnecter) — c'est NORMAL
      //    Ça arrive parfois après le scan QR juste avant l'open
      if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
        sessionData.reconnectCount = (sessionData.reconnectCount || 0) + 1
        if (sessionData.reconnectCount <= 3) {
          console.log(`[${sessionId}] Restart required — reconnexion ${sessionData.reconnectCount}/3`)
          // Reconnexion silencieuse — préserve les credentials du dossier
          setTimeout(() => {
            startSession(sessionId, method, phoneNumber, true).catch(e => {
              console.error(`[${sessionId}] Reconnexion KO:`, e.message)
              sessionData.status = 'error'
              sessionData.error = 'Reconnexion échouée.'
            })
          }, 2000)
          return
        }
        sessionData.status = 'error'
        sessionData.error = 'Trop de reconnexions. Réessayez.'
        return
      }

      // 4. Autre cas — on ignore, Baileys peut émettre des close transitoires
      //    Ne PAS marquer en erreur ici car ça casse les cas légitimes
      console.log(`[${sessionId}] Close transitoire ignoré (code ${statusCode})`)
    }
  })

  // Cleanup timeout 8 min
  setTimeout(() => {
    const s = sessions.get(sessionId)
    if (s && s.status !== 'done' && !s.finalized) {
      console.log(`[${sessionId}] Timeout 8min — nettoyage`)
      s.status = 'error'
      s.error = 'Délai dépassé. Veuillez réessayer.'
      cleanupSession(sessionId)
    }
  }, 8 * 60 * 1000)
}

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
app.listen(PORT, () => console.log(`Chris MD Session Generator — port ${PORT}`))

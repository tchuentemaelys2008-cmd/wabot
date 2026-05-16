/**
 * Chris MD Session Generator — VERSION CORRIGÉE
 *
 * Changements critiques :
 *  - sock.logout() après génération réussie → libère le slot d'appareil côté WhatsApp
 *  - sock.logout() au cleanup → pas d'appareils fantômes
 *  - Pas de reconnexion auto sur 'close' avant 'done' → évite les multi-créations
 *  - Un seul scheduleClean propre
 *  - Auto-follow et envoi de messages sécurisés (try/catch isolés, pas de plantage en chaîne)
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

// ─── CLEANUP : logout WhatsApp + ferme socket + supprime dossier ─────────────
async function cleanupSession(sessionId, options = {}) {
  const { logout = true } = options
  const s = sessions.get(sessionId)
  if (s) {
    // Logout WhatsApp : crucial pour libérer le slot d'appareil
    if (logout && s.socket) {
      try {
        await s.socket.logout('cleanup')
        console.log(`[${sessionId}] ✅ Logout WhatsApp réussi`)
      } catch (e) {
        // logout peut échouer si déjà déconnecté — pas grave
        console.log(`[${sessionId}] Logout: ${e.message}`)
      }
    }
    // Fermer la socket réseau
    try { s.socket?.end?.(undefined) } catch {}
    try { s.socket?.ws?.close?.() } catch {}
    sessions.delete(sessionId)
  }
  // Supprimer le dossier auth local
  const dir = path.join('/tmp', sessionId)
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }) } catch {}
}

function scheduleClean(sessionId, delayMs = 15 * 60 * 1000) {
  setTimeout(() => {
    cleanupSession(sessionId).catch(() => {})
  }, delayMs)
}

function compressSession(credsContent) {
  const compressed = zlib.deflateSync(Buffer.from(credsContent, 'utf8'))
  return 'CHRIS_MD_' + compressed.toString('base64')
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
    cleanupScheduled: false,
  }
  sessions.set(sessionId, sessionData)

  // ── Pair code ────────────────────────────────────────────────────────────
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

    if (connection === 'open') {
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

        // Auto-follow chaîne WhatsApp Chris MD (isolé)
        try {
          const channelMeta = await sock.newsletterMetadata('invite', '0029Vark1I1AYlUR1G8YMX31')
          if (channelMeta && channelMeta.id) {
            await sock.newsletterFollow(channelMeta.id)
            console.log(`[${sessionId}] ✅ Chaîne Chris MD suivie`)
          }
        } catch (e) {
          console.log(`[${sessionId}] Follow chaîne échoué (non bloquant): ${e.message}`)
        }

        // Messages WhatsApp séparés (chaque envoi est isolé)
        const jid = sock.user.id
        try {
          await sock.sendMessage(jid, {
            text:
              `✅ *Session Chris MD générée avec succès !*\n\n` +
              `Votre bot est prêt à être déployé.`
          })
        } catch (e) { console.log(`[${sessionId}] Message 1 KO:`, e.message) }

        try {
          await sock.sendMessage(jid, { text: sessionString })
        } catch (e) { console.log(`[${sessionId}] Message 2 KO:`, e.message) }

        try {
          await sock.sendMessage(jid, {
            text:
              `🚀 *Finalisez le déploiement :*\n\n` +
              `👉 https://xhrishost.site/dashboard/bots\n\n` +
              `Collez votre SESSION_ID et lancez votre bot en un clic.\n\n` +
              `⚠️ Ne partagez jamais votre session.`
          })
        } catch (e) { console.log(`[${sessionId}] Message 3 KO:`, e.message) }

        // ⚠️ CRUCIAL : laisse 2s pour que les messages soient effectivement envoyés
        // côté serveur WhatsApp, PUIS on libère le slot d'appareil
        await new Promise(r => setTimeout(r, 2000))

        // 🔑 LIBÉRER LE SLOT D'APPAREIL CÔTÉ WHATSAPP
        // Sans ça, chaque génération laisse un appareil fantôme qui s'accumule.
        // Au bout de 4+ appareils, WhatsApp throttle, et au-delà : risque de ban.
        try {
          await sock.logout('session-generated')
          console.log(`[${sessionId}] 🔓 Appareil libéré côté WhatsApp`)
        } catch (e) {
          console.log(`[${sessionId}] Logout KO (non bloquant):`, e.message)
        }

        // Nettoyage différé du dossier auth local
        // logout: false car on a déjà logout au-dessus
        if (!sessionData.cleanupScheduled) {
          sessionData.cleanupScheduled = true
          setTimeout(() => {
            cleanupSession(sessionId, { logout: false }).catch(() => {})
          }, 15 * 60 * 1000)
        }

      } catch (e) {
        console.error(`[${sessionId}] Erreur:`, e.message)
        sessionData.status = 'error'
        sessionData.error = e.message
      }
    }

    if (connection === 'close') {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log(`[${sessionId}] Fermé, code:`, statusCode)

      if (sessionData.status === 'done') {
        // Tout est bon, on a déjà logout — pas besoin de reconnecter
        return
      }

      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        sessionData.status = 'error'
        sessionData.error = 'Session expirée. Réessayez.'
        // Cleanup léger (pas de logout, socket déjà fermée)
        cleanupSession(sessionId, { logout: false }).catch(() => {})
        return
      }

      // ⚠️ PAS DE RECONNEXION AUTOMATIQUE
      // L'ancienne version rappelait startSession() ici, ce qui créait un
      // NOUVEL appareil pour la MÊME tentative → multiplication d'appareils
      // fantômes. Maintenant on marque en erreur et l'utilisateur réessaye
      // manuellement depuis le frontend.
      if (sessionData.status !== 'done' && sessionData.status !== 'error') {
        sessionData.status = 'error'
        sessionData.error = 'Connexion perdue avant la fin. Veuillez réessayer.'
        cleanupSession(sessionId, { logout: false }).catch(() => {})
      }
    }
  })

  // Cleanup de sécurité après 8 min : si la session n'a pas fini, on libère tout
  setTimeout(() => {
    const s = sessions.get(sessionId)
    if (s && s.status !== 'done') {
      console.log(`[${sessionId}] Timeout 8min — nettoyage`)
      cleanupSession(sessionId).catch(() => {})
    }
  }, 8 * 60 * 1000)
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────
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

// Endpoint optionnel pour cleanup manuel (utile pour debug)
app.delete('/api/session/:sessionId', async (req, res) => {
  try {
    await cleanupSession(req.params.sessionId)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Chris MD Session Generator — port ${PORT}`))

// The desktop viewer on the preview origin (served as /__mp_preview/desktop.js, see desktop.ts). It
// connects noVNC to this page's own WebSocket, which the preview listener tunnels to the
// environment's VNC bridge. View-only pages also tell noVNC not to send input; the view-only port's
// VNC server refuses it anyway.
import RFB from '/__mp_preview/novnc/core/rfb.js'

const body = document.body
const viewOnly = body.dataset.viewOnly === '1'
const thumbnail = body.dataset.thumbnail === '1'
const screen = document.getElementById('screen')
const status = document.getElementById('status')
const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${location.pathname.replace(/\/?$/, '/')}websockify`

let delay = 1000

const show = (text) => {
  status.textContent = text
  status.hidden = !text
}

const retry = () => {
  setTimeout(connect, delay)
  delay = Math.min(delay * 2, 30000)
}

function connect() {
  show('Connecting…')
  let rfb
  try {
    rfb = new RFB(screen, url, { shared: true })
  } catch {
    show('Could not connect')
    retry()
    return
  }
  rfb.viewOnly = viewOnly
  rfb.scaleViewport = true
  rfb.resizeSession = false
  rfb.focusOnClick = !viewOnly
  rfb.showDotCursor = !viewOnly
  rfb.background = '#08090a'
  rfb.qualityLevel = thumbnail ? 3 : 6
  rfb.compressionLevel = thumbnail ? 9 : 2
  rfb.addEventListener('connect', () => {
    delay = 1000
    show('')
  })
  rfb.addEventListener('securityfailure', () => show('The desktop refused the connection'))
  rfb.addEventListener('disconnect', (e) => {
    show(e.detail.clean ? 'Disconnected. Reconnecting…' : 'Connection lost. Reconnecting…')
    retry()
  })
}

connect()

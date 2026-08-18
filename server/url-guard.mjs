import net from 'node:net'

/** Verhindert, dass der Proxy als Sprungbrett ins interne Netz dient (SSRF). */
export function isPrivateHost(hostname) {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (net.isIP(host) === 0) return false
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false
  const [a, b] = parts
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

export function checkTarget(raw) {
  let target
  try {
    target = new URL(raw)
  } catch {
    throw new Error('Ungueltige URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('Nur http/https erlaubt')
  if (isPrivateHost(target.hostname)) throw new Error('Interne Adressen sind nicht erlaubt')
  return target
}

export const USER_AGENT = 'nachrichten-app/1.0 (podcast client)'
export const MAX_REDIRECTS = 5

/** Folgt Weiterleitungen von Hand, damit jeder Hop geprueft wird. */
export async function fetchGuarded(startUrl, init, onHop) {
  let target = startUrl
  for (let hop = 0; ; hop++) {
    const response = await fetch(target, { ...init, redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      if (hop >= MAX_REDIRECTS) throw new Error('Zu viele Weiterleitungen')
      target = checkTarget(new URL(location, target).toString())
      if (onHop) onHop(target)
      continue
    }
    return response
  }
}

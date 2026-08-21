import net from 'node:net'
import dns from 'node:dns/promises'

/** Ziel bewusst abgelehnt - im Gegensatz zu "nicht erreichbar". */
export class NichtErlaubt extends Error {}

function istPrivatIPv4(host) {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

/**
 * IPv6 in die acht Gruppen ausschreiben - "::" wieder mit Nullen auffuellen.
 *
 * Ein Praefixvergleich auf der Textform reicht nicht: dieselbe Adresse laesst
 * sich sehr verschieden schreiben ("::1", "0:0:0:0:0:0:0:1").
 */
function ipv6Gruppen(host) {
  const [links, rechts] = host.split('::')
  const zuZahlen = (teil) => (teil ? teil.split(':').map((g) => parseInt(g, 16)) : [])
  if (rechts === undefined) return zuZahlen(links)
  const vorne = zuZahlen(links)
  const hinten = zuZahlen(rechts)
  const luecke = 8 - vorne.length - hinten.length
  if (luecke < 0) return []
  return [...vorne, ...new Array(luecke).fill(0), ...hinten]
}

function istPrivatIPv6(host) {
  const g = ipv6Gruppen(host)
  if (g.length !== 8 || g.some((n) => !Number.isInteger(n))) return true

  // ::  (unbestimmt) und ::1 (loopback)
  if (g.slice(0, 7).every((n) => n === 0)) return true
  // Eingebettete IPv4-Adresse: ::ffff:a.b.c.d und das alte ::a.b.c.d.
  // Node schreibt sie als Hex ("::ffff:7f00:1"), deshalb hier zurueckrechnen.
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) {
    const v4 = [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
    return istPrivatIPv4(v4)
  }
  // fc00::/7 (unique local) und fe80::/10 (link local)
  if ((g[0] & 0xfe00) === 0xfc00) return true
  if ((g[0] & 0xffc0) === 0xfe80) return true
  return false
}

/** Verhindert, dass der Proxy als Sprungbrett ins interne Netz dient (SSRF). */
export function isPrivateHost(hostname) {
  // Der URL-Parser laesst IPv6 in eckigen Klammern stehen ("[::1]"). Ohne sie
  // abzustreifen erkennt net.isIP die Adresse nicht - und frueher rutschte
  // damit jede IPv6-Adresse ungeprueft durch.
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const art = net.isIP(host)
  if (art === 4) return istPrivatIPv4(host)
  if (art === 6) return istPrivatIPv6(host)
  // Kein Literal, sondern ein Name - der wird erst beim Aufloesen zur Adresse.
  return false
}

export function checkTarget(raw) {
  let target
  try {
    target = new URL(raw)
  } catch {
    throw new Error('Ungueltige URL')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new NichtErlaubt('Nur http/https erlaubt')
  if (isPrivateHost(target.hostname)) throw new NichtErlaubt('Interne Adressen sind nicht erlaubt')
  return target
}

/**
 * Den Namen aufloesen und JEDE Adresse pruefen, die dabei herauskommt.
 *
 * checkTarget sieht nur die Zeichenkette. Ein Name, der auf eine interne
 * Adresse zeigt, lief damit ungehindert durch - und dafuer muss niemand eine
 * Domain registrieren, "127.0.0.1.nip.io" genuegt. Genau das war das Loch,
 * das die Adresspruefung eigentlich stopfen soll.
 *
 * Bleibt ein Restrisiko: zwischen dieser Auskunft und dem Verbindungsaufbau
 * fragt fetch() den Namen selbst noch einmal, und eine Antwort mit sehr kurzer
 * Gueltigkeit kann sich dazwischen aendern (DNS-Rebinding). Das sauber zu
 * schliessen hiesse, auf die gepruefte IP zu verbinden und den Namen nur im
 * Host-Header zu fuehren - bei https passt dann das Zertifikat nicht mehr.
 * Der leicht gemachte Angriff ist damit weg, der aufwendige bleibt moeglich.
 */
export async function pruefeAufloesung(target) {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // Literale hat checkTarget bereits geprueft, da gibt es nichts aufzuloesen.
  if (net.isIP(host) !== 0) return

  let adressen
  try {
    adressen = await dns.lookup(host, { all: true, verbatim: true })
  } catch (e) {
    throw new Error(`Name nicht aufloesbar (${host})`)
  }
  if (!adressen.length) throw new Error(`Name ohne Adresse (${host})`)
  for (const { address } of adressen) {
    if (isPrivateHost(address)) {
      throw new NichtErlaubt(`Interne Adressen sind nicht erlaubt (${host} -> ${address})`)
    }
  }
}

export const USER_AGENT = 'nachrichten-app/1.0 (podcast client)'
export const MAX_REDIRECTS = 5

/** Folgt Weiterleitungen von Hand, damit jeder Hop geprueft wird. */
export async function fetchGuarded(startUrl, init, onHop) {
  let target = startUrl
  for (let hop = 0; ; hop++) {
    // Vor jedem Hop, nicht nur vor dem ersten: eine Weiterleitung auf einen
    // Namen, der nach innen zeigt, waere sonst genauso gut wie die erste URL.
    await pruefeAufloesung(target)
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

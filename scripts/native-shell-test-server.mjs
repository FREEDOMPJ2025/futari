// Dev-only test server for the native shell load watchdog (#1672). Never deployed, not imported by the app.
//
// Why it exists: the watchdog and the self-returning offline page only show up on bad networks, and a
// bad network is hard to produce on a simulator. This server accepts connections and misbehaves on
// purpose, per mode, switchable at runtime.
//
// Usage
//   node scripts/native-shell-test-server.mjs [port]            (default 3999, MODE=<mode> sets the start mode)
//   curl 'http://localhost:3999/__mode?m=stall'                 switch mode while running
//   Android emulator: adb reverse tcp:3999 tcp:3999, build the shell with CAP_SERVER_URL=http://localhost:3999
//   iOS simulator:    build the shell with CAP_SERVER_URL=http://localhost:3999 (simulator shares the host network)
//
// Modes (all apply to HTML documents; /__mode and /favicon.ico always answer)
//   normal          200 after 200 ms
//   stall           accept, never answer (the case from the issue)
//   delayN          every HTML response takes N seconds (delay9, delay20, ...)
//   fastroot        `/` answers at once and does location.replace('/dashboard'); `/dashboard` takes 9 s
//   fastrootN       same, `/dashboard` takes N seconds (fastroot20)
//   fastrootstall   `/` answers at once and does location.replace('/dashboard'); `/dashboard` never answers
//   blockingcss     HTML at once, a render-blocking stylesheet hangs 15 s
//   hangimg         HTML at once, an image hangs 15 s
//   503             every HTML response is a 503
//   offorigin       `/offsite` 302-redirects to another origin (OFFORIGIN_TARGET, default https://example.com/)
//   redirect        `/dashboard` 307-redirects to `/sign-in`
//
// In-app navigation without any debug code in the app: every page takes ?go=<action>&after=<seconds>
// and runs it by itself after the delay. Examples:
//   /?go=reload&after=3                  location.reload()
//   /?go=replace:/dashboard&after=3      location.replace('/dashboard')
//   /?go=replace:/offsite&after=3        (offorigin mode)
//   /__mode?m=normal&rootgo=reload&rootafter=3   the NEXT `/` served auto-runs the action once (no taps needed)
// Fragment-only navigation cases (#1680). Every page has `<a id=anchor href="#sec">` and a `#sec` target:
//   /?go=anchor&after=3                  click the anchor            -> watchdog log: SKIP fragment-only
//   /?go=push-anchor&after=3             history.pushState to /b, then click the anchor (/b#sec) -> SKIP
//   /?go=unfrag&after=3                  replaceState to /a#x, 1 s later location.href='/a'     -> ARM
//   /?go=reload-frag&after=3             replaceState to /#x, 1 s later location.reload()       -> ARM
//   (cross-page case: /?go=replace:/a&after=3 -> ARM). Combine with `hangimg` (15 s image) and after=3
//   to see the old bug: ARM on an anchor, then FIRE at 6 s over a page that already showed.
//   Same via the one-shot: /__mode?m=hangimg&rootgo=anchor&rootafter=3
// Start the app on `/` (it loads server.url), then use the on-page links or a `go` URL; the server
// log prints request and close timestamps, which is what the acceptance cases compare against.
import http from 'node:http'

const port = Number(process.argv[2] || process.env.PORT || 3999)
let mode = process.env.MODE || 'normal'
// One-shot auto-navigation for the next `/` served (set via /__mode?rootgo=&rootafter=), so a simulator
// with no tap tool can still trigger an in-app reload/replace. Cleared after one use, so reload can't loop.
let rootGo = null
const offTarget = process.env.OFFORIGIN_TARGET || 'https://example.com/'
const t0 = Date.now()
const ts = () => String(Date.now() - t0).padStart(7, ' ')
const log = (...a) => console.log(`[${ts()}ms]`, ...a)

const page = (title, extra = '', head = '', query = new URLSearchParams()) => {
  const go = query.get('go')
  const after = Math.max(0, Number(query.get('after') || 0)) * 1000
  let auto = ''
  if (go === 'reload') auto = 'location.reload()'
  else if (go === 'anchor') auto = `document.getElementById('anchor').click()`
  else if (go === 'push-anchor') auto = `history.pushState(null,'','/b');document.getElementById('anchor').click()`
  else if (go === 'unfrag') auto = `history.replaceState(null,'','/a#x');setTimeout(function(){location.href='/a'},1000)`
  else if (go === 'reload-frag') auto = `history.replaceState(null,'','/#x');setTimeout(function(){location.reload()},1000)`
  else if (go && go.startsWith('replace:')) auto = `location.replace(${JSON.stringify(go.slice('replace:'.length))})`
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${head}
<style>body{font:18px system-ui;padding:24px;background:#FBEDE0}button,a{display:block;margin:12px 0;padding:14px;font-size:18px}</style></head>
<body><h1>${title}</h1><p>mode=${mode} loaded at <span id=t></span></p>
<script>document.getElementById('t').textContent=new Date().toISOString();
${auto ? `setTimeout(function(){${auto}}, ${after});` : ''}</script>
<a href="/?go=reload&after=3">reload in 3 s</a>
<a href="/?go=replace:/dashboard&after=3">replace /dashboard in 3 s</a>
<a id="anchor" href="#sec">anchor #sec</a><a href="/a">link /a</a><a href="/dashboard">link /dashboard</a><a href="/offsite">link /offsite</a>
<div id="sec" style="margin-top:60px">#sec target</div>
${extra}</body></html>`
}

function sendHtml(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const q = url.searchParams
  log(req.method, req.url, `mode=${mode}`)
  res.on('close', () => log('  closed', req.method, req.url, res.writableEnded ? '(responded)' : '(client aborted)'))

  if (path === '/__mode') {
    const m = q.get('m')
    if (m) {
      log(`MODE SWITCH ${mode} -> ${m}`)
      mode = m
    }
    if (q.get('rootgo')) {
      rootGo = { go: q.get('rootgo'), after: q.get('rootafter') || '3' }
      log(`ROOT GO armed: ${rootGo.go} after ${rootGo.after}s (one-shot)`)
    }
    return sendHtml(res, `mode=${mode}\n`)
  }
  if (path === '/favicon.ico') {
    res.writeHead(204)
    return res.end()
  }
  if (path === '/slow.css') return void setTimeout(() => { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body{}') }, 15000)
  if (path === '/slow.png') return void setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png' }); res.end() }, 15000)

  const title = path === '/' ? 'Home' : path
  const delayMatch = /^delay(\d+)$/.exec(mode)
  const fastrootMatch = /^fastroot(\d*)$/.exec(mode)
  let pq = q
  // The Android shell can fetch `/` more than once at launch, so the armed action applies to every `/`
  // served within 2 s of its first use; the auto-navigation itself fires later (rootafter), outside the window.
  if (path === '/' && !q.get('go') && rootGo) {
    if (!rootGo.until) rootGo.until = Date.now() + 2000
    if (Date.now() <= rootGo.until) {
      pq = new URLSearchParams({ go: rootGo.go, after: rootGo.after })
      log(`ROOT GO used: ${rootGo.go}`)
    } else rootGo = null
  }
  const html = (t = title, extra, head) => page(t, extra, head, pq)
  const rootBounce = `<!doctype html><html><head><meta charset="utf-8"></head><body>redirecting<script>location.replace('/dashboard')</script></body></html>`

  switch (true) {
    case mode === 'stall':
      return // never respond
    case mode === '503':
      return sendHtml(res, html('503'), 503)
    case !!fastrootMatch:
      if (path === '/') return sendHtml(res, rootBounce)
      if (path === '/dashboard') {
        const seconds = Number(fastrootMatch[1] || 9)
        return void setTimeout(() => sendHtml(res, html(`dashboard (after ${seconds}s)`)), seconds * 1000)
      }
      return sendHtml(res, html())
    case mode === 'fastrootstall':
      if (path === '/') return sendHtml(res, rootBounce)
      if (path === '/dashboard') return // never respond
      return sendHtml(res, html())
    case mode === 'blockingcss':
      return sendHtml(res, html(title, '', '<link rel="stylesheet" href="/slow.css">'))
    case mode === 'hangimg':
      return sendHtml(res, html(title, '<img src="/slow.png" width=50 height=50 alt="slow">'))
    case mode === 'offorigin' && path === '/offsite':
      res.writeHead(302, { location: offTarget })
      return res.end()
    case mode === 'redirect' && path === '/dashboard':
      res.writeHead(307, { location: '/sign-in' })
      return res.end()
    case !!delayMatch:
      return void setTimeout(() => sendHtml(res, html()), Number(delayMatch[1]) * 1000)
    default:
      return void setTimeout(() => sendHtml(res, html()), 200)
  }
})
server.keepAliveTimeout = 0
server.listen(port, '0.0.0.0', () => log(`listening on :${port} mode=${mode}`))
